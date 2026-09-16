import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadProgressMessageStore } from "../src/telegram/progress_store.js";
import { createTelegramRuntimeResponder } from "../src/telegram/runtime_responder.js";
import { createLiveProgressController } from "../src/ui/live_progress.js";
import { createRecoveryTurn } from "../src/recovery/startup.js";
import { recoveryCandidateFromSnapshot } from "../src/recovery/state.js";
import { normalizePendingTurn, serializePendingTurn } from "../src/queue.js";

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "telegram-progress-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "progress.json");
  const store = await loadProgressMessageStore(file);
  const deleted = [];
  const telegram = { deleteMessage: async (...args) => deleted.push(args) };
  const responder = (progressStore) => createTelegramRuntimeResponder({
    bot: { telegram }, progressStore,
    settings: { runtimeValue: () => true }, localization: { text: (key) => key },
    logger: { warn: () => {} }
  });
  return { file, store, deleted, telegram, responder };
}

test("disk-backed progress survives bot restart and stays isolated by turn and topic", async (t) => {
  const { file, store, responder, telegram, deleted } = await fixture(t);
  const original = { chatKey: "-100:10", progressTurnId: "user-turn", messageRefs: [] };
  const otherTurn = { chatKey: "-100:10", progressTurnId: "next-turn", messageRefs: [] };
  const otherTopic = { chatKey: "-100:11", progressTurnId: "user-turn", messageRefs: [] };
  const ctx = { chat: { id: -100 }, telegram };
  await responder(store).trackProgressMessage(ctx, original, { message_id: 101 });
  await responder(store).trackProgressMessage(ctx, otherTurn, { message_id: 102 });
  await responder(store).trackProgressMessage(ctx, otherTopic, { message_id: 103 });
  // Recreate all controllers from the file, as a new bot process would.
  const restartedStore = await loadProgressMessageStore(file);
  const live = createLiveProgressController({ progressStore: restartedStore });
  const recoveredTurn = createRecoveryTurn(recoveryCandidateFromSnapshot({
    chatKey: original.chatKey, queueItemId: "replacement-worker-job",
    progressTurnId: original.progressTurnId
  }), { restartId: "second-restart" });
  const queued = normalizePendingTurn(serializePendingTurn(recoveredTurn), { chatKey: original.chatKey });
  const progress = live.createLiveProgressState({ currentPreparedTurn: queued }, original.chatKey);
  assert.deepEqual(progress.messageRefs, [{ chatId: -100, messageId: 101 }]);
  await responder(restartedStore).deleteTrackedProgressMessages(ctx, progress);
  assert.deepEqual(deleted, [[-100, 101]]);
  const persisted = await loadProgressMessageStore(file);
  assert.deepEqual(persisted.getRefs(original), []);
  assert.equal(persisted.getRefs(otherTurn).length, 1);
  assert.equal(persisted.getRefs(otherTopic).length, 1);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
});

test("transient deletion failures remain pending and retry after process restart", async (t) => {
  const { file, store, responder, telegram, deleted } = await fixture(t);
  const progress = { chatKey: "42", progressTurnId: "turn", messageRefs: [] };
  const ctx = { chat: { id: 42 }, telegram };
  await responder(store).trackProgressMessage(ctx, progress, { message_id: 5 });
  const originalDelete = telegram.deleteMessage;
  telegram.deleteMessage = async () => { throw Object.assign(new Error("reset"), { code: "ECONNRESET" }); };
  await responder(store).deleteTrackedProgressMessages(ctx, progress);
  assert.equal(progress.messageRefs.length, 1);
  const restartedStore = await loadProgressMessageStore(file);
  assert.equal(restartedStore.pending().length, 1);
  telegram.deleteMessage = originalDelete;
  await responder(restartedStore).retryPendingProgressCleanup();
  assert.deepEqual(deleted, [[42, 5]]);
  assert.deepEqual((await loadProgressMessageStore(file)).pending(), []);
});

test("already deleted messages are cleared, while rate limits keep remaining refs", async (t) => {
  const { file, store, responder, telegram } = await fixture(t);
  const progress = { chatKey: "42", progressTurnId: "turn", messageRefs: [] };
  const ctx = { chat: { id: 42 }, telegram };
  for (const id of [5, 6, 7]) await responder(store).trackProgressMessage(ctx, progress, { message_id: id });
  const attempted = [];
  telegram.deleteMessage = async (_chat, id) => {
    attempted.push(id);
    throw { response: {
      error_code: id === 5 ? 400 : 429,
      description: id === 5 ? "Bad Request: message to delete not found" : "Too Many Requests",
      parameters: { retry_after: 1 }
    } };
  };
  await responder(store).deleteTrackedProgressMessages(ctx, progress);
  assert.deepEqual(attempted, [5, 6]);
  assert.deepEqual((await loadProgressMessageStore(file)).getRefs(progress).map((ref) => ref.messageId), [6, 7]);
});

test("concurrent progress writes remain complete and expired bookkeeping is pruned", async (t) => {
  const { file } = await fixture(t);
  let now = Date.now();
  const store = await loadProgressMessageStore(file, { now: () => now });
  const progress = { chatKey: "42", progressTurnId: "turn" };
  await Promise.all(Array.from({ length: 20 }, (_, index) => store.track(progress, { chatId: 42, messageId: index + 1 })));
  assert.equal((await loadProgressMessageStore(file)).getRefs(progress).length, 20);
  now += 49 * 60 * 60 * 1000;
  await store.prune();
  assert.deepEqual((await loadProgressMessageStore(file)).getRefs(progress), []);
});
