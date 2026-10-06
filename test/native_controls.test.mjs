import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { nativeUsageSample, currentNativeUsage } from "../src/codex/native_usage.js";
import { createCodexStreamState, applyCodexStreamEvent, codexStreamResult } from "../src/codex/stream.js";
import { codexEventError } from "../src/accounts/errors.js";
import { updateNativeProgress } from "../src/codex/native_progress.js";
import { createWorkerStore } from "../src/worker/store.js";
import { runWorkerJob } from "../src/worker/executor.js";
import { inspectWorkerJob } from "../src/worker/inspection.js";
import { createNativeControls, nativeControlsKeyboard } from "../src/telegram/native_controls.js";
async function storeFixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "native-controls-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return createWorkerStore({ codexWorkerStateDir: dir });
}


test("native terminal statuses remain distinct and missing usage does not erase native snapshots", () => {
  const s = createCodexStreamState();
  const usage = { total: { inputTokens: 10, cachedInputTokens: 3, outputTokens: 5, totalTokens: 15 }, last: { inputTokens: 8, outputTokens: 4 }, modelContextWindow: 100 };
  assert.equal(applyCodexStreamEvent(s, { method: "thread/tokenUsage/updated", params: { tokenUsage: usage } }).type, "usage");
  applyCodexStreamEvent(s, { method: "thread/tokenUsage/updated", params: { tokenUsage: usage } });
  applyCodexStreamEvent(s, { method: "turn/completed", params: { turn: { status: "completed" } } });
  assert.equal(codexStreamResult(s).usage.total_tokens, 15);
  const interrupted = { method: "turn/completed", params: { turn: { status: "interrupted" } } };
  assert.equal(applyCodexStreamEvent(s, interrupted).code, "turn_interrupted");
  assert.equal(codexEventError(interrupted).code, "turn_interrupted");
  assert.equal(applyCodexStreamEvent(s, { method: "turn/completed", params: { turn: { status: "failed", error: { message: "failure" } } } }).type, "error");
  assert.equal(applyCodexStreamEvent(s, { method: "turn/completed", params: { turn: { status: "futureStatus" } } }).type, "error");
  const sample = nativeUsageSample(usage, { threadId: "thread", accountId: "a" });
  assert.equal(sample.tokenCount.info.last_token_usage.input_tokens, 8);
  assert.equal(currentNativeUsage({ nativeUsage: sample, accountId: "b" }, "thread"), null);
  assert.equal(currentNativeUsage({ nativeUsage: sample, accountId: "a" }, "other"), null);
});

test("worker publishes cancellation for server interrupted turns and persists native progress", async (t) => {
  const store = await storeFixture(t);
  await assert.rejects(runWorkerJob({ job: { id: "interrupt", chatKey: "chat" }, config: {}, store, createThread: () => ({ id: "thread", runStreamed: async () => ({ events: (async function* () {
    yield { method: "turn/plan/updated", params: { plan: [{ step: "One", status: "inProgress" }] } };
    yield { method: "turn/completed", params: { turn: { status: "interrupted" } } };
  })() }) }) }), { code: "turn_interrupted" });
  const job = await store.readJobState("interrupt");assert.equal(job.status, "cancelled");assert.equal(job.nativeProgress.plan[0].step, "One");
  assert.equal((await store.readJobEvents(job.id)).some((e) => e.type === "worker.job.completed"), false);
});

test("read-only recovery binds account/thread/turn/client ID and does not mutate or resubmit", async () => {
  const job = { id: "job", chatKey: "10:20", requesterUserId: "7", status: "failed", inputReceipt: { clientId: "client", threadId: "thread", turnId: "turn", status: "sending" } };
  const store = { readJobState: async () => job };
  const params = { jobId: "job", chatKey: "10:20", userId: "7", remote: true };
  let calls = 0;
  const readThread = async () => { calls++;return { thread: { id: "thread", turns: [{ id: "turn", status: "completed", items: [{ type: "userMessage", clientId: "client" }, { type: "agentMessage", text: "done" }] }] } }; };
  await assert.rejects(inspectWorkerJob({ ...params, userId: "8" }, { store, config: {}, readThread }), /owner/);assert.equal(calls, 0);
  const found = await inspectWorkerJob(params, { store, config: {}, readThread });assert.equal(found.receipt, "recovered");assert.equal(found.result, "done");assert.equal(job.status, "failed");
  job.inputReceipt.clientId = "different";
  assert.equal((await inspectWorkerJob(params, { store, config: {}, readThread })).receipt, "uncertain");
  assert.equal((await inspectWorkerJob(params, { store, config: {}, readThread: async () => { throw new Error("offline"); } })).inspectionUnavailable, true);
});

test("native progress and recovery buttons fit Telegram limit and inspect using requester identity", async () => {
  const progress = updateNativeProgress({}, { type: "turn.diff", diff: "--- a/src/a.js\n+++ b/src/a.js\n+x" });assert.deepEqual(progress.files, ["src/a.js"]);
  const jobId = "long".repeat(30);const keyboard = nativeControlsKeyboard(jobId, (x) => x);
  assert.ok(keyboard.reply_markup.inline_keyboard[0].every((b) => Buffer.byteLength(b.callback_data) <= 64));
  let sent;let inspected;
  const ui = createNativeControls({ getClient: () => ({ inspectJob: async (p) => { inspected = p;return { jobId, status: "failed", receipt: "uncertain", progress: {} }; } }), getChatKey: () => "10:20", activeTurns: new Map([["10:20", { workerJobId: jobId }]]), deliveries: () => ({}), queue: () => [], steering: { reconcile: async () => {} }, text: (x) => x });
  await ui.handle({ from: { id: 7 }, callbackQuery: { data: keyboard.reply_markup.inline_keyboard[0][0].callback_data }, answerCbQuery: async () => {}, reply: async (s) => { sent = s; } });
  assert.deepEqual(inspected, { jobId, chatKey: "10:20", userId: "7", remote: true });assert.match(sent, /nativeReceipt_uncertain/);
});

test("native progress feeds the shared dashboard even with commentary disabled", async () => {
  const { createLiveProgressController } = await import("../src/ui/live_progress.js");
  const { textFor } = await import("../src/i18n.js");
  const sent = []; const updates = [];
  const controller = createLiveProgressController({
    settings: { runtimeValue: () => "off" },
    options: { get: () => ({ liveProgressEnabled: false }) },
    telegram: { getChatKey: () => "chat", replyTracked: async (...args) => sent.push(args),
      updateStatus: async (state, event) => updates.push({ progress: state.active.nativeProgress, event }) },
    recovery: { recordProgressFailed: async () => {} }, localization: { language: () => "en", forLanguage: textFor }, formatting: {}
  });
  const active = { nativeProgress: { files: ["old"] }, dashboardResult: { delivered: true } };
  const state = controller.createLiveProgressState(active, "chat");
  assert.equal(active.dashboardResult, undefined);
  const ctx = { chat: { id: 1 } };
  await controller.maybeSendLiveProgress(ctx, state, { type: "turn.plan", plan: [{ step: "Inspect", status: "inProgress" }] }, []);
  await controller.maybeSendLiveProgress(ctx, state, { type: "turn.diff", diff: "+++ b/a.js\n+test" }, []);
  await controller.maybeSendLiveProgress(ctx, state, { type: "turn.completed" }, []);
  assert.equal(sent.length, 0); assert.equal(updates.length, 3);
  assert.equal(updates.at(-1).progress.status, "completed");
  assert.deepEqual(updates.at(-1).progress.files, ["a.js"]);
  assert.deepEqual(state.messageRefs, []);
});

test("native inspect refreshes the unified card only after owner verification", async () => {
  let inspected = false; let refreshed = 0; let replies = 0;
  const ui = createNativeControls({ getClient: () => ({ inspectJob: async () => {
    inspected = true; return { jobId: "job", progress: {} };
  } }), getChatKey: () => "1", activeTurns: new Map([["1", { workerJobId: "job" }]]),
  deliveries: () => ({}), queue: () => [], steering: {}, text: (k) => k,
  refreshStatus: async (_ctx, view) => { assert.equal(inspected, true); assert.equal(view.chatKey, "1"); refreshed++; return true; } });
  await ui.handle({ from: { id: 7 }, callbackQuery: { data: nativeControlsKeyboard("job", (k) => k).reply_markup.inline_keyboard[0][0].callback_data },
    answerCbQuery: async () => {}, reply: async () => replies++ });
  assert.equal(refreshed, 1); assert.equal(replies, 0);
});

test("dashboard scheduled inspection still passes the clicking user to worker authorization", async () => {
  let params; let replies = 0;
  const ui = createNativeControls({ getClient: () => ({ inspectJob: async (p) => { params = p; throw new Error("Inspection owner mismatch"); } }),
    getChatKey: () => "1:topic:9", activeTurns: new Map(), deliveries: () => ({}), queue: () => [], steering: {}, text: (k) => k,
    resolveStatusJob: () => ({ jobId: "scheduled", chatKey: "task:scheduled" }), refreshStatus: () => assert.fail("not authorized") });
  await ui.handle({ from: { id: 8 }, callbackQuery: { data: nativeControlsKeyboard("scheduled", (k) => k).reply_markup.inline_keyboard[0][0].callback_data },
    answerCbQuery: async () => {}, reply: async () => replies++ });
  assert.deepEqual(params, { jobId: "scheduled", chatKey: "task:scheduled", userId: "8", remote: true });
  assert.equal(replies, 1);
});

test("completed original input recovers from native history; unrelated or unfinished turns stay held", async (t) => {
  const { recoverCompletedInput } = await import("../src/worker/input_recovery.js");
  const { reconstructCompletedWorkerJob, isWorkerRestartFailure } = await import("../src/worker/replay.js");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "receipt-recovery-")); t.after(() => fs.rm(dir, { recursive: true, force: true })); const store = createWorkerStore({ codexWorkerStateDir: dir }); await store.ensure();
  const job = { id: "original", chatKey: "chat", status: "running", inputReceipt: { clientId: "native-original", threadId: "thread", accountId: "default" } };
  await store.writeJobState(job);
  for (const [status, clientId, expected] of [["inProgress", "native-original", false], ["completed", "wrong", false], ["completed", "native-original", true]]) {
    const result = await recoverCompletedInput(job, { config: {}, store, readThread: async () => ({ thread: { id: "thread", turns: [{ id: "turn", status,
      items: [{ type: "userMessage", id: "user", clientId }, { type: "agentMessage", id: "answer", text: "Recovered final answer" }] }] } }) });
    assert.equal(result, expected);
  }
  const result = await reconstructCompletedWorkerJob({ readJobEvents: async (id, afterSeq) => ({ events: await store.readJobEvents(id, { afterSeq }) }) }, job.id);
  assert.equal(result.turn.finalResponse, "Recovered final answer");
  assert.equal((await store.readJobState(job.id)).status, "completed");
  assert.equal(isWorkerRestartFailure({ failureReason: "input_interrupted", error: "worker restarted before job completed" }), false);
});


test("worker startup holds uncertain original delivery when native evidence is unavailable", async (t) => {
  const { createWorkerServer } = await import("../src/worker/server.js");
  const { isWorkerRestartFailure } = await import("../src/worker/replay.js");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "receipt-recovery-")); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const config = { codexPath: path.join(dir, "not-installed"), codexWorkerStateDir: dir, codexWorkerSocket: path.join(dir, "worker.sock") };
  const store = createWorkerStore(config); await store.ensure();
  const job = { id: "lost-input", chatKey: "chat", status: "running", inputReceipt: { threadId: "thread", clientId: "native" } };
  await store.writeJobState(job); await store.upsertActiveJob(job);
  const server = createWorkerServer({ config, store, logger: { warn() {} } });
  try {
    await server.listen();
    const held = await store.readJobState(job.id);
    assert.equal(held.failureReason, "input_interrupted");
    assert.equal(isWorkerRestartFailure(held), false);
    assert.equal(held.terminalEvent.type, "worker.job.failed");
  } finally { await server.close(); }
});

