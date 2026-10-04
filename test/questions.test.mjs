import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createWorkerStore } from "../src/worker/store.js";
import { createQuestionBroker } from "../src/worker/questions.js";
import { createQuestionUi } from "../src/telegram/questions.js";

async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "questions-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = createWorkerStore({ codexWorkerStateDir: dir });
  const job = { id: "test", chatKey: "10:20", requesterUserId: "7" };
  await store.writeJobState(job);
  const controller = new AbortController();
  const broker = createQuestionBroker({ store, controllers: new Map([[job.id, controller]]) });
  const request = { id: 1, params: { isBlocking: true, threadId: "thread", turnId: "turn", questions: Array.from({ length: 4 }, (_, i) => ({ id: `q${i}`, question: `Question ${i}`, options: [{ label: "A", description: "first" }, { label: "B", description: "second" }] })) } };
  return { store, job, controller, broker, request };
}
async function ready(broker) {
  for (let i = 0; i < 100; i++) {
    const q = await broker.current("10:20");
    if (q) return q;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("Question did not appear");
}
function answer(q, overrides = {}) {
  return { jobId: q.jobId, questionId: q.id, index: q.index, chatKey: "10:20", userId: "7", option: 1, ...overrides };
}
test("four choices block until all answered, persist each answer and reject duplicates/foreign users", async (t) => {
  const { broker, store, job, request, controller } = await setup(t);
  let completed = false;
  const waiting = broker.ask(job, request, controller.signal).then((r) => { completed = true; return r; });
  let q = await ready(broker);
  await assert.rejects(broker.answer(answer(q, { userId: "8" })), /identity/);
  await assert.rejects(broker.answer(answer(q, { chatKey: "other" })), /identity/);
  const duplicates = await Promise.all([broker.answer(answer(q)), broker.answer(answer(q))]);
  assert.equal(duplicates.filter((r) => r.stale).length, 1);
  assert.equal(completed, false);
  assert.equal((await store.readJobState(job.id)).userQuestion.index, 1);
  for (let i = 1; i < 4; i++) {
    q = await ready(broker);
    assert.equal(q.index, i);
    await broker.answer(answer(q));
    if (i < 3) assert.equal(completed, false);
  }
  assert.deepEqual(Object.keys((await waiting).answers), ["q0", "q1", "q2", "q3"]);
  assert.equal((await store.readJobState(job.id)).userQuestion.state, "answered");
  assert.equal(await broker.current("10:20"), null);
});
test("cancellation rejects pending request; nonblocking and secret prompts fail closed", async (t) => {
  const { broker, store, job, request, controller } = await setup(t);
  await assert.rejects(broker.ask(job, { ...request, params: { ...request.params, isBlocking: false } }, controller.signal), /Non-blocking/);
  await assert.rejects(broker.ask(job, { ...request, params: { ...request.params, questions: [{ id: "secret", question: "secret", isSecret: true }] } }, controller.signal), /secrets/);
  const pending = broker.ask(job, request, controller.signal);
  const rejected = assert.rejects(pending, /interrupted/);
  const q = await ready(broker);
  await broker.answer(answer(q, { cancel: true }));
  await rejected;
  assert.equal((await store.readJobState(job.id)).userQuestion.state, "cancelled");
});
test("a fresh broker never resolves a persisted old request after worker restart", async (t) => {
  const { broker, store, job, request, controller } = await setup(t);
  const pending = broker.ask(job, request, controller.signal);
  const rejected = assert.rejects(pending, /interrupted/);
  const q = await ready(broker);
  const restarted = createQuestionBroker({ store, controllers: new Map() });
  assert.equal(await restarted.current(job.chatKey), null);
  assert.deepEqual(await restarted.answer(answer(q)), { stale: true });
  controller.abort();
  await rejected;
});
test("Telegram advances one question at a time and rejects an old button", async (t) => {
  const { broker, job, request, controller } = await setup(t);
  const pending = broker.ask(job, request, controller.signal);
  const rejected = assert.rejects(pending, /interrupted/);
  const q = await ready(broker);
  const messages = [];
  const ctx = { chat: { id: 10 }, from: { id: 7 }, reply: async (body, extra) => { messages.push({ body, extra }); return { message_id: messages.length }; }, answerCbQuery: async () => {}, telegram: { editMessageReplyMarkup: async () => {} } };
  const ui = createQuestionUi({ getClient: () => ({ currentQuestion: broker.current, answerQuestion: broker.answer }), getChatKey: () => job.chatKey, text: (key) => key });
  await ui.poll(ctx);
  await ui.poll(ctx);
  assert.equal(messages.length, 1);
  assert.match(messages[0].body, /1\/4/);
  const data = messages[0].extra.reply_markup.inline_keyboard[0][0].callback_data;
  assert.ok(Buffer.byteLength(data) <= 64);
  ctx.callbackQuery = { data, message: { message_id: 1 } };
  await ui.handle(ctx, () => assert.fail("not ordinary queue input"));
  assert.match(messages[1].body, /2\/4/);
  await ui.handle(ctx, () => assert.fail());
  assert.equal((await broker.current(job.chatKey)).index, 1);
  assert.equal(q.questions.length, 4);
  controller.abort();
  await rejected;
});
