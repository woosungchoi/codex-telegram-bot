import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { Telegraf } from "telegraf";
import { createPollingGuard } from "../src/telegram/polling_guard.js";

function fixture(original) {
  let time = 1_000_000;
  const timers = new Map(), logs = [];
  const guard = createPollingGuard(original, {
    now: () => time,
    logger: { warn: (_prefix, value) => logs.push(JSON.parse(value)), log: (_prefix, value) => logs.push(JSON.parse(value)) },
    setTimer: (fn, ms) => { const id = {}; timers.set(id, { fn, at: time + ms }); return id; },
    clearTimer: (id) => timers.delete(id)
  });
  return {
    guard, logs, timers,
    tick(ms) {
      time += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= time) { timers.delete(id); timer.fn(); }
    }
  };
}

function hanging(_method, _payload, { signal }) {
  return new Promise((_resolve, reject) => {
    const abort = () => reject(Object.assign(new Error("cancelled"), { name: "AbortError" }));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

test("normal long polls stay quiet; non-poll APIs retain arguments and receiver", async () => {
  const receiver = {}, payload = { timeout: 50, offset: 27 }, options = { custom: true };
  let finish;
  const f = fixture(function (method, input, opts) {
    assert.equal(this, receiver);
    if (method !== "getUpdates") { assert.equal(opts, options); return "sent"; }
    assert.equal(input, payload);
    return new Promise((resolve) => { finish = resolve; });
  });
  assert.equal(await f.guard.callApi.call(receiver, "sendMessage", {}, options), "sent");
  assert.equal(f.timers.size, 0);
  const poll = f.guard.callApi.call(receiver, "getUpdates", payload);
  f.tick(50_000); finish([]);
  assert.deepEqual(await poll, []);
  assert.deepEqual(f.logs, []);
  assert.equal(f.guard.snapshot().lastDurationMs, 50_000);
  assert.equal(f.timers.size, 0);
});

test("stalled request warns at 65s and aborts at 75s as a retryable FetchError", async () => {
  const f = fixture(hanging), parent = new AbortController();
  const poll = f.guard.callApi("getUpdates", { timeout: 50 }, parent);
  const rejected = assert.rejects(poll, { name: "FetchError", code: "ETIMEDOUT" });
  f.tick(65_000);
  assert.equal(f.logs.at(-1).event, "telegram_poll_slow");
  f.tick(10_000);
  await rejected;
  assert.equal(parent.signal.aborted, false, "do not stop Telegraf's entire polling loop");
  assert.equal(f.guard.snapshot().timeouts, 1);
  assert.equal(f.guard.snapshot().totalErrors, 1);
  assert.equal(f.timers.size, 0);
});

for (const stopped of [false, true]) test(`parent shutdown keeps AbortError and does not retry (guard stopped=${stopped})`, async () => {
  const f = fixture(hanging), parent = new AbortController();
  const poll = f.guard.callApi("getUpdates", { timeout: 50 }, parent);
  const rejected = assert.rejects(poll, { name: "AbortError" });
  if (stopped) f.guard.stop();
  parent.abort();
  await rejected;
  f.tick(100_000);
  assert.equal(f.guard.snapshot().totalErrors, 0);
  assert.deepEqual(f.logs, []);
  assert.equal(f.timers.size, 0);
});

test("already-aborted parent cannot start a fresh live request", async () => {
  const f = fixture(hanging), parent = new AbortController();
  parent.abort();
  await assert.rejects(f.guard.callApi("getUpdates", { timeout: 50 }, parent), { name: "AbortError" });
  assert.deepEqual(f.logs, []);
  assert.equal(f.timers.size, 0);
});

test("transport errors are redacted, retained in metrics, and followed by one recovery log", async () => {
  let fail = true;
  const error = Object.assign(new Error("request to https://api.telegram.org/bot123456:secret-token/getUpdates failed via https://user:password@proxy.invalid"), {
    name: "FetchError", code: "ECONNRESET"
  });
  const f = fixture(async () => { if (fail) throw error; return []; });
  for (let i = 0; i < 2; i++) await assert.rejects(f.guard.callApi("getUpdates", { timeout: 50 }), (e) => e === error);
  fail = false;
  await f.guard.callApi("getUpdates", { timeout: 50 });
  await f.guard.callApi("getUpdates", { timeout: 50 });
  assert.equal(f.guard.snapshot().consecutiveErrors, 0);
  assert.equal(f.guard.snapshot().totalErrors, 2);
  assert.equal(f.guard.snapshot().lastError.code, "ECONNRESET");
  assert.equal(f.logs.filter((e) => e.event === "telegram_poll_recovered").length, 1);
  assert.doesNotMatch(JSON.stringify([f.logs, f.guard.snapshot()]), /secret-token|password/);
});

for (const code of [401, 409, 429, 502]) test(`Telegram API ${code} keeps its error identity and retry policy`, async () => {
  const error = Object.assign(new Error("API error"), { code, parameters: { retry_after: 30 } });
  const f = fixture(async () => { throw error; });
  await assert.rejects(f.guard.callApi("getUpdates", { timeout: 50 }), (e) => e === error);
  assert.equal(f.guard.snapshot().lastError.code, code);
  assert.equal(f.guard.snapshot().lastError.retryAfter, 30);
});

test("message lag logs metadata without content and excludes old callback/edited messages", async () => {
  const updates = [
    { update_id: 1, message: { date: 960, text: "private message" } },
    { update_id: 2, callback_query: { message: { date: 1, text: "private callback" } } },
    { update_id: 3, edited_message: { date: 1, text: "private edit" } }
  ];
  const f = fixture(async () => updates);
  assert.equal(await f.guard.callApi("getUpdates", { timeout: 50 }), updates);
  assert.equal(f.guard.snapshot().lastUpdateLagMs, 40_000);
  assert.equal(f.logs[0].event, "telegram_update_delayed");
  assert.doesNotMatch(JSON.stringify(f.logs), /private/);
  updates.shift();
  await f.guard.callApi("getUpdates", { timeout: 50 });
  assert.equal(f.logs.length, 1);
  assert.equal(f.guard.snapshot().lastUpdateLagMs, null);
  assert.equal(f.guard.snapshot().maxUpdateLagMs, 40_000);
});

for (const stalledBody of [false, true]) test(`real Telegraf recovers without duplicate consumers or offset loss (partial body=${stalledBody})`, { timeout: 12_000 }, async (t) => {
  // node-fetch v2 leaves its 500s body timer alive after AbortError. Track only
  // that dependency timer and clear it AFTER the real cancellation/retry test;
  // do not change transport timing or mask overlapping requests during the test.
  const dependencyTimers = [], realSetTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (fn, ms, ...args) => {
    const timer = realSetTimeout(fn, ms, ...args);
    if (ms === 500_000) dependencyTimers.push(timer);
    return timer;
  });
  t.after(() => dependencyTimers.forEach(clearTimeout));
  let active = 0, maxActive = 0, calls = 0;
  const offsets = [], delivered = [], sockets = new Set();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const method = req.url.split("/").at(-1);
      const input = JSON.parse(Buffer.concat(chunks).toString());
      const reply = (result) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ ok: true, result })); };
      if (method === "getMe") return reply({ id: 123, is_bot: true, first_name: "fixture", username: "fixture_bot" });
      if (method === "deleteWebhook") return reply(true);
      assert.equal(method, "getUpdates");
      offsets.push(input.offset);
      if (input.limit === 1) return reply([]);
      active++; maxActive = Math.max(maxActive, active);
      res.once("close", () => active--);
      if (++calls === 1) {
        // Cover both no response headers and a response whose body never ends.
        if (stalledBody) { res.setHeader("content-type", "application/json"); res.write('{"ok":true,"result":['); }
        return;
      }
      reply([{ update_id: 81, message: { message_id: 1, date: Math.floor(Date.now() / 1000), chat: { id: 7, type: "private" }, from: { id: 7, is_bot: false, first_name: "fixture" }, text: "hello" } }]);
    });
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const bot = new Telegraf("123:fixture", { telegram: { apiRoot: `http://127.0.0.1:${server.address().port}` } });
  const logs = [];
  const guard = createPollingGuard(bot.telegram.callApi, {
    timeoutMs: 500, warnAfterMs: 300,
    logger: { warn: (_p, v) => logs.push(JSON.parse(v)), log: (_p, v) => logs.push(JSON.parse(v)) }
  });
  bot.telegram.callApi = guard.callApi;
  bot.on("text", (ctx) => { delivered.push(ctx.update.update_id); bot.stop("test complete"); });
  t.after(() => { guard.stop(); if (bot.polling) bot.polling.stop(); });
  await bot.launch();
  assert.deepEqual(delivered, [81]);
  assert.equal(calls, 2);
  assert.equal(maxActive, 1);
  assert.deepEqual(offsets, [0, 0, 82]);
  assert.ok(logs.some((e) => e.event === "telegram_poll_recovered"));
});
