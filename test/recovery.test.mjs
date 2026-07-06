import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appendRecoveryJournal, summarizeStreamEvent } from "../src/recovery/journal.js";
import {
  applyRecoveryThreadToChatState,
  buildStartupRecoveryActions,
  buildStartupRecoveryPlan,
  clearEmptyRestartMarker,
  clearStaleRestartMarker,
  createRecoveryTurn,
  hasRecoveryStartNoticeBeenSent,
  markRecoveryStartNoticeSent,
  markRecoveryAttempt
} from "../src/recovery/startup.js";
import { createRestartMarkerFromActiveTurns } from "../src/recovery/restart.js";
import {
  readActiveTurnSnapshots,
  readRecoveryDedupe,
  readRestartMarker,
  isDuplicateRestartUpdate,
  rememberRestartUpdate,
  removeActiveTurnSnapshot,
  recoveryPaths,
  upsertActiveTurnSnapshot
} from "../src/recovery/state.js";

async function tmpRecoveryDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "codex-bot-recovery-"));
}

test("recovery journal appends one JSON object per line", async () => {
  const dir = await tmpRecoveryDir();
  await appendRecoveryJournal(dir, { type: "turn_started", chatKey: "1" });
  await appendRecoveryJournal(dir, { type: "turn_completed", chatKey: "1" });
  const body = await fs.readFile(recoveryPaths(dir).journal, "utf8");
  const entries = body.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(entries.map((entry) => entry.type), ["turn_started", "turn_completed"]);
  assert.equal(entries.every((entry) => typeof entry.at === "string"), true);
});

test("stream event summaries omit message bodies", () => {
  assert.deepEqual(summarizeStreamEvent({
    type: "item.completed",
    item: { id: "item-1", type: "agent_message", text: "secret final answer" }
  }), {
    eventType: "item.completed",
    itemId: "item-1",
    itemType: "agent_message",
    status: "",
    length: 19
  });
});

test("active snapshots are written atomically and read back", async () => {
  const dir = await tmpRecoveryDir();
  await upsertActiveTurnSnapshot(dir, "chat-1", {
    chatId: 100,
    threadId: "thread-1",
    recoveryEligible: true,
    lastEventAt: "2026-06-15T00:00:00.000Z"
  });
  const active = await readActiveTurnSnapshots(dir);
  assert.equal(active.turns["chat-1"].chatId, 100);
  assert.equal(active.turns["chat-1"].threadId, "thread-1");
  assert.equal((await fs.readdir(dir)).some((name) => name.endsWith(".tmp")), false);
});

test("thread start updates active snapshot and completed turns remove it", async () => {
  const dir = await tmpRecoveryDir();
  await upsertActiveTurnSnapshot(dir, "chat-1", {
    chatId: 100,
    inputPreview: "long report",
    recoveryEligible: true,
    lastKnownStatus: "running",
    lastEventAt: "2026-06-15T00:00:00.000Z"
  });
  await upsertActiveTurnSnapshot(dir, "chat-1", {
    threadId: "thread-after-start",
    lastKnownStatus: "thread_started",
    lastEventAt: "2026-06-15T00:00:05.000Z"
  });
  let active = await readActiveTurnSnapshots(dir);
  assert.equal(active.turns["chat-1"].threadId, "thread-after-start");
  assert.equal(active.turns["chat-1"].inputPreview, "long report");
  assert.equal(active.turns["chat-1"].lastKnownStatus, "thread_started");

  await removeActiveTurnSnapshot(dir, "chat-1");
  active = await readActiveTurnSnapshots(dir);
  assert.equal(active.turns["chat-1"], undefined);
});

test("restart marker captures eligible active turn candidates", async () => {
  const dir = await tmpRecoveryDir();
  await upsertActiveTurnSnapshot(dir, "chat-1", {
    chatId: 100,
    threadId: "thread-1",
    inputPreview: "continue work",
    recoveryEligible: true,
    lastEventAt: "2026-06-15T00:00:00.000Z"
  });
  await upsertActiveTurnSnapshot(dir, "chat-2", {
    chatId: 200,
    threadId: "thread-2",
    recoveryEligible: false,
    lastEventAt: "2026-06-15T00:00:00.000Z"
  });
  const marker = await createRestartMarkerFromActiveTurns(dir, {
    now: new Date("2026-06-15T00:01:00.000Z"),
    restartId: "rst_test",
    reason: "self_restart"
  });
  assert.equal(marker.restartId, "rst_test");
  assert.equal(marker.recoveries.length, 1);
  assert.equal(marker.recoveries[0].chatKey, "chat-1");
});

test("startup plan filters stale and repeated recovery candidates", async () => {
  const dir = await tmpRecoveryDir();
  await upsertActiveTurnSnapshot(dir, "fresh", {
    chatId: 100,
    threadId: "thread-fresh",
    recoveryEligible: true,
    lastEventAt: "2026-06-15T00:00:00.000Z"
  });
  await upsertActiveTurnSnapshot(dir, "stale", {
    chatId: 200,
    threadId: "thread-stale",
    recoveryEligible: true,
    lastEventAt: "2026-06-14T00:00:00.000Z"
  });
  await markRecoveryAttempt(dir, {
    chatKey: "fresh",
    threadId: "thread-fresh",
    reason: "startup_recovery"
  }, { now: new Date("2026-06-15T00:01:00.000Z") });
  const plan = await buildStartupRecoveryPlan(dir, {
    now: new Date("2026-06-15T00:02:00.000Z"),
    maxAgeSeconds: 3600,
    suspendAfter: 1,
    reason: "startup_recovery"
  });
  assert.deepEqual(plan.candidates.map((candidate) => candidate.chatKey), []);
  assert.deepEqual(plan.suspended.map((candidate) => candidate.chatKey), ["fresh"]);
  assert.deepEqual(plan.stale.map((candidate) => candidate.chatKey), ["stale"]);
});

test("empty restart markers are cleared after startup planning", async () => {
  const dir = await tmpRecoveryDir();
  const marker = await createRestartMarkerFromActiveTurns(dir, {
    now: new Date("2026-06-15T00:01:00.000Z"),
    restartId: "rst_empty",
    reason: "self_restart"
  });
  assert.equal(marker.recoveries.length, 0);
  const plan = await buildStartupRecoveryPlan(dir, {
    now: new Date("2026-06-15T00:02:00.000Z"),
    maxAgeSeconds: 3600,
    reason: "startup_recovery"
  });

  assert.equal(await clearEmptyRestartMarker(dir, plan), true);
  assert.equal(await readRestartMarker(dir), null);
  const journal = await fs.readFile(recoveryPaths(dir).journal, "utf8");
  assert.match(journal, /restart_marker_cleared_empty/);
});

test("startup recovery actions create recovery turns from restart marker candidates", async () => {
  const dir = await tmpRecoveryDir();
  await upsertActiveTurnSnapshot(dir, "chat-1", {
    chatId: 100,
    messageThreadId: 300,
    threadId: "thread-1",
    inputPreview: "continue work",
    workingDirectory: "/repo",
    recoveryEligible: true,
    lastEventAt: "2026-06-15T00:00:00.000Z"
  });
  await createRestartMarkerFromActiveTurns(dir, {
    now: new Date("2026-06-15T00:01:00.000Z"),
    restartId: "rst_test",
    reason: "self_restart"
  });
  const plan = await buildStartupRecoveryPlan(dir, {
    now: new Date("2026-06-15T00:02:00.000Z"),
    maxAgeSeconds: 3600,
    reason: "startup_recovery"
  });

  const actions = buildStartupRecoveryActions(plan, {
    ttlSeconds: 60,
    workingDirectory: "/fallback",
    now: new Date("2026-06-15T00:02:00.000Z")
  });

  assert.equal(actions.turns.length, 1);
  assert.equal(actions.turns[0].id, "recovery:rst_test:chat-1");
  assert.equal(actions.turns[0].kind, "recovery");
  assert.equal(actions.turns[0].messageThreadId, 300);
  assert.equal(actions.turns[0].recovery.threadId, "thread-1");
  assert.match(actions.turns[0].inputText, /threadId: thread-1/);
  assert.deepEqual(actions.skippedActive, []);
});

test("startup recovery actions skip candidates already active", async () => {
  const candidate = {
    chatKey: "chat-1",
    chatId: 100,
    threadId: "thread-1",
    reason: "startup_recovery",
    recoveryKey: "rk"
  };
  const actions = buildStartupRecoveryActions({
    marker: { restartId: "rst_test" },
    candidates: [candidate],
    stale: [],
    suspended: []
  }, {
    activeChatKeys: ["chat-1"]
  });

  assert.deepEqual(actions.turns, []);
  assert.deepEqual(actions.skippedActive, [candidate]);
});

test("stale restart markers are reported and cleared when no fresh work remains", async () => {
  const dir = await tmpRecoveryDir();
  await upsertActiveTurnSnapshot(dir, "stale", {
    chatId: 100,
    threadId: "thread-stale",
    recoveryEligible: true,
    lastEventAt: "2026-06-14T00:00:00.000Z"
  });
  await createRestartMarkerFromActiveTurns(dir, {
    now: new Date("2026-06-15T00:01:00.000Z"),
    restartId: "rst_stale",
    reason: "self_restart"
  });
  const plan = await buildStartupRecoveryPlan(dir, {
    now: new Date("2026-06-15T00:02:00.000Z"),
    maxAgeSeconds: 3600,
    reason: "startup_recovery"
  });

  assert.deepEqual(plan.candidates, []);
  assert.deepEqual(plan.stale.map((candidate) => candidate.chatKey), ["stale"]);
  assert.equal(await clearStaleRestartMarker(dir, plan), true);
  assert.equal(await readRestartMarker(dir), null);
  const journal = await fs.readFile(recoveryPaths(dir).journal, "utf8");
  assert.match(journal, /restart_marker_cleared_stale/);
});

test("manual recovery planning can include suspended candidates", async () => {
  const dir = await tmpRecoveryDir();
  await upsertActiveTurnSnapshot(dir, "fresh", {
    chatId: 100,
    threadId: "thread-fresh",
    recoveryEligible: true,
    lastEventAt: "2026-06-15T00:00:00.000Z"
  });
  await markRecoveryAttempt(dir, {
    chatKey: "fresh",
    threadId: "thread-fresh",
    reason: "manual_recovery"
  }, { now: new Date("2026-06-15T00:01:00.000Z") });
  const plan = await buildStartupRecoveryPlan(dir, {
    now: new Date("2026-06-15T00:02:00.000Z"),
    maxAgeSeconds: 3600,
    suspendAfter: Number.POSITIVE_INFINITY,
    reason: "manual_recovery"
  });
  assert.deepEqual(plan.candidates.map((candidate) => candidate.chatKey), ["fresh"]);
  assert.deepEqual(plan.suspended, []);
});

test("recovery turn keeps chat metadata and embeds a recovery prompt", async () => {
  const turn = createRecoveryTurn({
    chatKey: "chat-1",
    chatId: 100,
    messageThreadId: 300,
    replyToMessageId: 20,
    originMessageId: 10,
    originUpdateId: 99,
    threadId: "thread-1",
    reason: "self_restart",
    recoveryKey: "rk"
  }, {
    restartId: "rst_test",
    ttlSeconds: 60,
    now: new Date("2026-06-15T00:00:00.000Z"),
    workingDirectory: "/repo"
  });
  assert.equal(turn.id, "recovery:rst_test:chat-1");
  assert.equal(turn.messageThreadId, 300);
  assert.equal(turn.replyToMessageId, 20);
  assert.equal(turn.kind, "recovery");
  assert.equal(turn.recovery.chatKey, "chat-1");
  assert.match(turn.inputText, /Do not blindly re-run unfinished tool calls/);
  assert.equal(turn.expiresAt, "2026-06-15T00:01:00.000Z");
});

test("recovery turn thread id is applied to chat state before resume", () => {
  const chat = { threadId: "old-thread", options: {}, updatedAt: "old" };
  const turn = { kind: "recovery", recovery: { threadId: "thread-1" } };
  assert.equal(
    applyRecoveryThreadToChatState(chat, turn, {
      now: new Date("2026-06-15T00:00:00.000Z")
    }),
    true
  );
  assert.equal(chat.threadId, "thread-1");
  assert.equal(chat.updatedAt, "2026-06-15T00:00:00.000Z");
  assert.equal(applyRecoveryThreadToChatState(chat, turn), false);
  assert.equal(applyRecoveryThreadToChatState(chat, { kind: "user" }), false);
});

test("recovery dedupe increments attempts for started attempts only", async () => {
  const dir = await tmpRecoveryDir();
  const candidate = { chatKey: "chat-1", threadId: "thread-1", reason: "startup_recovery" };
  await markRecoveryAttempt(dir, candidate, { status: "started", now: new Date("2026-06-15T00:00:00.000Z") });
  await markRecoveryAttempt(dir, candidate, { status: "failed", now: new Date("2026-06-15T00:01:00.000Z") });
  await markRecoveryAttempt(dir, candidate, { status: "failed", now: new Date("2026-06-15T00:02:00.000Z") });
  const dedupe = await readRecoveryDedupe(dir);
  const entry = Object.values(dedupe.recentRecoveryKeys)[0];
  assert.equal(entry.attempts, 1);
  assert.equal(entry.failures, 2);
  assert.equal(entry.warning, true);
  assert.equal(entry.lastStatus, "failed");
  const journal = await fs.readFile(recoveryPaths(dir).journal, "utf8");
  assert.match(journal, /recovery_failure_warning/);
});

test("recovery start notice dedupe is tracked per recovery key", async () => {
  const dir = await tmpRecoveryDir();
  const candidate = { chatKey: "chat-1", threadId: "thread-1", reason: "startup_recovery" };
  assert.equal(await hasRecoveryStartNoticeBeenSent(dir, candidate), false);
  await markRecoveryStartNoticeSent(dir, candidate, { now: new Date("2026-06-15T00:00:00.000Z") });
  assert.equal(await hasRecoveryStartNoticeBeenSent(dir, candidate), true);
  const entry = Object.values((await readRecoveryDedupe(dir)).recentRecoveryKeys)[0];
  assert.equal(entry.startNoticeSentAt, "2026-06-15T00:00:00.000Z");
});

test("restart update dedupe remembers Telegram redeliveries", async () => {
  const dir = await tmpRecoveryDir();
  assert.equal(await rememberRestartUpdate(dir, 12345), true);
  const dedupe = await readRecoveryDedupe(dir);
  assert.equal(dedupe.lastRestartUpdateId, 12345);
  assert.equal(isDuplicateRestartUpdate(dedupe, 12345), true);
  assert.equal(isDuplicateRestartUpdate(dedupe, 12346), false);
  assert.equal(await rememberRestartUpdate(dir, "not-an-id"), false);
});
