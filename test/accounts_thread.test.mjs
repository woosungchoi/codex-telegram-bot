import test from "node:test";
import assert from "node:assert/strict";
import { accountFixture } from "./helpers/accounts_fixture.mjs";
import { createAccountThread } from "../src/accounts/thread.js";
import { classifyAccountFailure } from "../src/accounts/errors.js";

async function setup(t) {
  const f = await accountFixture(t);
  const b = await f.store.create("Backup");
  await f.store.update(b.id, { status: "ready" });
  await f.store.setAutoRotate(true);
  return { ...f, b };
}
const failed = { type: "turn.failed", error: { message: "You have hit your usage limit.", codexErrorInfo: "usageLimitExceeded" } };
const done = { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } };
async function collect(thread, signal) {
  const { events } = await thread.runStreamed("CURRENT_REQUEST", { signal });
  const list = [];
  for await (const event of events) list.push(event);
  return list;
}

test("quota exhaustion rotates only after the prior iterator exits and carries portable context", async (t) => {
  const { config, store, b } = await setup(t);
  const calls = [];
  let priorClosed = false;
  const thread = createAccountThread({ config, store, threadId: "original", transport: "sdk", readHistory: async () => "Previously completed work",
    createThread: (scoped, id) => ({ async runStreamed(input) {
      calls.push({ id: scoped.codexAccountId, threadId: id, input });
      return { events: (async function* () {
        if (scoped.codexAccountId === "default") {
          try { yield failed; } finally { priorClosed = true; }
        } else {
          assert.equal(priorClosed, true);
          yield { type: "thread.started", thread_id: "replacement" };
          yield { type: "item.completed", item: { id: "1", type: "agent_message", text: "done" } };
          yield done;
        }
      })() };
    } })
  });
  const events = await collect(thread);
  assert.deepEqual(calls.map((x) => x.id), ["default", b.id]);
  assert.equal(calls[1].threadId, "");
  assert.match(calls[1].input, /Previously completed work/);
  assert.match(calls[1].input, /CURRENT_REQUEST/);
  assert.equal(events.some((e) => e.type === "turn.failed"), false);
  assert.equal(events.at(-1).type, "account.selected");
  assert.equal(thread.accountId, b.id);
  assert.equal(thread.id, "replacement");
});

test("a failed tool-bearing turn is never replayed on another account", async (t) => {
  const { config, store } = await setup(t);
  const calls = [];
  const thread = createAccountThread({ config, store, createThread: (c) => {
    calls.push(c.codexAccountId);
    return { async runStreamed() { return { events: (async function* () {
      yield { type: "item.started", item: { id: "tool", type: "command_execution", command: "deploy" } };
      yield failed;
    })() }; } };
  } });
  await assert.rejects(collect(thread), /usage limit/);
  assert.deepEqual(calls, ["default"]);
  assert.equal((await store.get("default")).failureCode, "quota");
});

test("rotation is opt-in and bounded to one attempt per eligible account", async (t) => {
  const { config, store, b } = await setup(t);
  const calls = [];
  const make = () => createAccountThread({ config, store, createThread: (c) => {
    calls.push(c.codexAccountId);
    return { async runStreamed() { return { events: (async function* () { yield failed; })() }; } };
  } });
  await store.setAutoRotate(false);
  await assert.rejects(collect(make()), /usage limit/);
  assert.deepEqual(calls, ["default"]);
  calls.length = 0;
  await store.setAutoRotate(true);
  await assert.rejects(collect(make()), /usage limit/);
  assert.deepEqual(calls, ["default", b.id]);
});

test("cancellation between attempts prevents the next CLI launch", async (t) => {
  const { config, store } = await setup(t);
  const abort = new AbortController();
  let count = 0;
  const thread = createAccountThread({ config, store, createThread: () => {
    count++;
    return { async runStreamed() { return { events: (async function* () { yield failed; })() }; } };
  } });
  const { events } = await thread.runStreamed("request", { signal: abort.signal });
  await assert.rejects(async () => {
    for await (const event of events) if (event.type === "account.rotation") abort.abort();
  }, { name: "AbortError" });
  assert.equal(count, 1);
});

test("transient retry notifications and successful completion do not rotate", async (t) => {
  const { config, store } = await setup(t);
  let calls = 0;
  const thread = createAccountThread({ config, store, createThread: () => {
    calls++;
    return { async runStreamed() { return { events: (async function* () {
      yield { method: "error", params: { error: { message: "retrying upstream" }, willRetry: true } };
      yield done;
    })() }; } };
  } });
  await collect(thread);
  assert.equal(calls, 1);
});

test("malformed requests, permissions, network failures and generic throttling are not account failures", () => {
  for (const message of ["Bad Request", "403 Forbidden", "429 Too Many Requests", "ECONNRESET", "context length exceeded", "model not found", "cancelled"]) {
    assert.equal(classifyAccountFailure(new Error(message)), null, message);
  }
  assert.equal(classifyAccountFailure(Object.assign(new Error("unauthorized"), { codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } } })).kind, "auth");
});

test("recovery skips previously failed accounts and prohibits replay after recorded activity", async (t) => {
  const { config, store, b } = await setup(t);
  const calls = [];
  const thread = createAccountThread({ config, store, accountId: b.id, attemptState: { triedAccountIds: ["default"], hadActivity: true }, createThread: (c) => {
    calls.push(c.codexAccountId);
    return { async runStreamed() { return { events: (async function* () { yield failed; })() }; } };
  } });
  await assert.rejects(collect(thread), /usage limit/);
  assert.deepEqual(calls, [b.id]);
});
