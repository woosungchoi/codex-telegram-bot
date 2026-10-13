import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { observeTelegramPolling } from "../src/telegram/polling_health.js";

test("polling health persists failures and recovery with private file permissions", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "telegram-polling-health-"));
  let fail = true;
  const bot = { telegram: { callApi: async () => {
    if (fail) throw Object.assign(new Error("connection reset"), { code: "ECONNRESET", name: "FetchError" });
    return [];
  } } };
  const original = bot.telegram.callApi;
  const h = observeTelegramPolling(bot, { codexUpdateDir: root }, { pid: 9, logger: { warn() {}, log() {} } });
  t.after(async () => { await h.stop(); h.close(); await fs.rm(root, { recursive: true, force: true }); });
  const file = path.join(root, "telegram-polling-health.json");
  const read = async () => JSON.parse(await fs.readFile(file, "utf8"));
  await assert.rejects(bot.telegram.callApi("getUpdates", { timeout: 50 }));
  assert.equal((await read()).polling.consecutiveErrors, 1);
  fail = false;
  await bot.telegram.callApi("getUpdates", { timeout: 50 });
  const health = await read();
  assert.equal(health.pid, 9);
  assert.equal(health.polling.totalErrors, 1);
  assert.equal(health.polling.consecutiveErrors, 0);
  assert.equal(health.polling.lastError.code, "ECONNRESET");
  assert.ok(health.polling.lastErrorAt <= health.polling.lastSuccessAt);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  await h.stop(); h.close();
  assert.equal((await read()).stopping, true);
  assert.equal(bot.telegram.callApi, original);
});

test("polling guard logs errors without a configured state directory", async () => {
  const logs = [];
  const failure = Object.assign(new Error("connection reset"), { name: "FetchError", code: "ECONNRESET" });
  const bot = { telegram: { callApi: async () => { throw failure; } } };
  const h = observeTelegramPolling(bot, {}, { logger: { warn: (...args) => logs.push(args) } });
  try {
    await assert.rejects(bot.telegram.callApi("getUpdates", { timeout: 50 }), (error) => error === failure);
    assert.match(JSON.stringify(logs), /telegram_poll_error/);
  } finally { await h.stop(); h.close(); }
});

test("unwritable diagnostics never fail successful Telegram polling", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "telegram-polling-health-error-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "not-a-directory");
  await fs.writeFile(file, "fixture");
  const warnings = [];
  const bot = { telegram: { callApi: async () => [] } };
  const h = observeTelegramPolling(bot, { codexUpdateDir: file }, { logger: { warn: (...args) => warnings.push(args) } });
  try {
    assert.deepEqual(await bot.telegram.callApi("getUpdates", { timeout: 50 }), []);
    assert.ok(warnings.length);
  } finally { await h.stop(); h.close(); }
});
