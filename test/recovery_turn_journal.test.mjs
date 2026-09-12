import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createTurnRecoveryJournal, digestText } from "../src/recovery/turn_journal.js";
import { readActiveTurnSnapshots } from "../src/recovery/state.js";
import { applyAccountEvent, rememberAccountThread } from "../src/accounts/context.js";

function createFixture({ enabled = false, recoveryDir = "/tmp/unused-recovery-journal", chat = {} } = {}) {
  const state = { worker: { deliveries: {} } };
  let saves = 0;
  const journal = createTurnRecoveryJournal({
    settings: {
      enabled,
      recoveryDir,
      defaultWorkdir: "/workspace",
      defaultModel: "model"
    },
    state,
    activeTurns: new Map(),
    threadCache: new Map(),
    chats: { get: () => chat },
    options: { get: () => ({}) },
    persistence: { save: async () => { saves += 1; } },
    telegram: { replyHtml: async () => {} },
    formatting: { truncate: (value, max) => String(value).slice(0, max) },
    text: (key) => key,
    now: () => new Date("2026-07-21T00:00:00.000Z")
  });
  return { journal, state, saves: () => saves };
}

test("disabled recovery journal leaves snapshots untouched", async () => {
  const { journal, state, saves } = createFixture();
  await journal.recordActiveTurnStarted("chat", { id: "turn", text: "hello" });
  await journal.recordActiveTurnFailed("chat", "failed");
  assert.deepEqual(state.worker.deliveries, {});
  assert.equal(saves(), 0);
});

test("account rotation and prior activity survive recovery snapshot writes", async (t) => {
  const recoveryDir = await fs.mkdtemp(path.join(os.tmpdir(), "accounts-recovery-"));
  t.after(() => fs.rm(recoveryDir, { recursive: true, force: true }));
  const chat = { accountId: "default", threadId: "old" };
  const { journal } = createFixture({ enabled: true, recoveryDir, chat });
  await journal.recordActiveTurnStarted("chat", { id: "turn", text: "hello" });
  const event = { type: "account.attempt.started", accountId: "backup", threadId: "", triedAccountIds: ["default", "backup"], hadActivity: true };
  applyAccountEvent(chat, event);
  await journal.recordAccountState("chat", event);
  let snapshot = (await readActiveTurnSnapshots(recoveryDir)).turns.chat;
  assert.equal(snapshot.accountId, "backup");
  assert.equal(snapshot.threadId, "");
  assert.equal(snapshot.accountAttemptState.hadActivity, true);
  rememberAccountThread(chat, "new", "backup");
  await journal.recordThreadStarted("chat", "new");
  snapshot = (await readActiveTurnSnapshots(recoveryDir)).turns.chat;
  assert.equal(snapshot.threadId, "new");
  assert.deepEqual(snapshot.accountAttemptState.triedAccountIds, ["default", "backup"]);
});

test("worker delivery transitions persist even when restart recovery is disabled", async () => {
  const { journal, state, saves } = createFixture();
  const execution = { executionMode: "sidecar", workerJobId: "job", workerLastSeq: 4 };

  await journal.recordTelegramReplyReady("chat", execution, "answer");
  await journal.recordTelegramReplyStarted("chat", execution, "answer");
  await journal.recordTelegramReplyCompleted("chat", execution, "answer");

  const [entry] = Object.values(state.worker.deliveries);
  assert.equal(entry.deliveryStatus, "delivery_sent");
  assert.equal(entry.responseDigest, digestText("answer"));
  assert.equal(entry.responseLength, 6);
  assert.equal(saves(), 3);
});

test("non-sidecar replies do not create worker delivery records", async () => {
  const { journal, state, saves } = createFixture();
  await journal.recordTelegramReplyReady("chat", { executionMode: "inline" }, "answer");
  assert.deepEqual(state.worker.deliveries, {});
  assert.equal(saves(), 0);
});

test("worker delivery failures preserve ambiguity and compact transport evidence", async () => {
  const { journal, state, saves } = createFixture();
  const error = Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
  await journal.recordTelegramReplyFailed(
    "chat",
    { executionMode: "sidecar", workerJobId: "job" },
    error,
    { ambiguous: false }
  );

  const [entry] = Object.values(state.worker.deliveries);
  assert.equal(entry.deliveryStatus, "delivery_failed");
  assert.equal(entry.ambiguous, false);
  assert.equal(entry.lastError.code, "ETIMEDOUT");
  assert.equal(saves(), 1);
});

test("worker response digest mismatches become non-ambiguous integrity failures", async () => {
  const { journal, state, saves } = createFixture();
  await journal.recordTelegramReplyDigestMismatch(
    "chat",
    { executionMode: "sidecar", workerJobId: "job" },
    "sha256:expected",
    "sha256:actual"
  );

  const [entry] = Object.values(state.worker.deliveries);
  assert.equal(entry.deliveryStatus, "delivery_failed");
  assert.equal(entry.ambiguous, false);
  assert.equal(entry.lastError.kind, "integrity");
  assert.equal(entry.lastError.code, "RESPONSE_DIGEST_MISMATCH");
  assert.equal(saves(), 1);
});
