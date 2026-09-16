import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadNotificationAccess, notificationTarget, sendBackgroundNotification } from "../src/telegram/background_notification.js";

const target = { botId: "12345", chatId: "67890", threadId: "" };
const access = { allowedUserIds: new Set(["67890"]), allowedChatIds: new Set(["-1001"]), allowedThreadIds: new Set() };
const sent = { from: { id: 12345 }, chat: { id: 67890 }, message_id: 21 };
const apiError = (code, retryAfter) => Object.assign(new Error("api error"), {
  response: { error_code: code, description: "rejected", parameters: { retry_after: retryAfter } }
});

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-notification-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const calls = [];
  const config = {
    target, text: "✅ 기사 배포 완료", receiptPath: path.join(root, "receipt.json"), sleep: async () => {},
    telegram: {
      getMe: async () => ({ id: 12345, is_bot: true, username: "expected_bot" }),
      sendMessage: async (...args) => { calls.push(args); return sent; }
    }
  };
  return { root, config, calls, receipt: async () => JSON.parse(await fs.readFile(config.receiptPath, "utf8")) };
}

test("sender uses only its own env file, not an ambient Hermes token", async (t) => {
  const { root } = await fixture(t);
  const before = process.env.TELEGRAM_BOT_TOKEN;
  t.after(() => { if (before === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = before; });
  process.env.TELEGRAM_BOT_TOKEN = "other-bot-credential";
  await fs.writeFile(path.join(root, ".env"), "TELEGRAM_BOT_TOKEN=own-bot-credential\nALLOWED_USER_IDS=67890\n");
  const config = await loadNotificationAccess(root);
  assert.equal(config.telegramBotToken, "own-bot-credential");
  assert.equal(process.env.TELEGRAM_BOT_TOKEN, "other-bot-credential");
});

test("target validation requires a bot and allowed chat/topic", () => {
  assert.deepEqual(notificationTarget(target, access), target);
  assert.throws(() => notificationTarget({ ...target, botId: "" }, access));
  assert.throws(() => notificationTarget({ ...target, chatId: "999" }, access));
  assert.throws(() => notificationTarget({ ...target, threadId: "bad" }, access));
  assert.throws(() => notificationTarget(target, { ...access, allowedThreadIds: new Set(["2"]) }));
  assert.deepEqual(notificationTarget({ ...target, chatId: "-1001", threadId: "2" }, access), { ...target, chatId: "-1001", threadId: "2" });
});

test("wrong bot fails before send, even when chat ID matches", async (t) => {
  const f = await fixture(t);
  f.config.telegram.getMe = async () => ({ id: 99999, is_bot: true, username: "wrong_bot" });
  const result = await sendBackgroundNotification(f.config);
  assert.equal(result.ok, false);
  assert.equal(result.status, "failed");
  assert.match(result.error.description, /bot-identity-mismatch/);
  assert.equal(f.calls.length, 0);
});

test("sent receipt records exact origin/message and reuses without duplicates", async (t) => {
  const f = await fixture(t);
  const result = await sendBackgroundNotification(f.config);
  assert.equal(result.ok, true);
  assert.equal(result.status, "sent");
  assert.equal(result.messageId, 21);
  assert.equal(result.recipientReadConfirmed, false);
  assert.equal(result.deliveryEvidence, "telegram_api_accepted");
  assert.equal(f.calls[0][2].disable_notification, false);
  assert.equal(Object.hasOwn(f.calls[0][2], "parse_mode"), false);
  assert.equal((await sendBackgroundNotification(f.config)).reused, true);
  assert.equal(f.calls.length, 1);
  assert.doesNotMatch(JSON.stringify(await f.receipt()), /기사 배포 완료/);
});

test("topic is preserved and verified on reply", async (t) => {
  const f = await fixture(t);
  f.config.target = { ...target, chatId: "-1001", threadId: "2" };
  f.config.telegram.sendMessage = async (chat, _text, extra) => {
    assert.equal(chat, "-1001"); assert.equal(extra.message_thread_id, 2);
    return { ...sent, chat: { id: -1001 }, message_thread_id: 2 };
  };
  assert.equal((await sendBackgroundNotification(f.config)).ok, true);
});

for (const [name, response] of [
  ["wrong sender", { ...sent, from: { id: 99999 } }],
  ["wrong chat", { ...sent, chat: { id: 99999 } }],
  ["wrong topic", { ...sent, message_thread_id: 2 }],
  ["missing message ID", { ...sent, message_id: undefined }]
]) {
  test(`${name} is uncertain, not successful or automatically retried`, async (t) => {
    const f = await fixture(t);
    f.config.telegram.sendMessage = async () => response;
    const result = await sendBackgroundNotification(f.config);
    assert.equal(result.ok, false);
    assert.equal(result.status, "uncertain");
    await assert.rejects(sendBackgroundNotification(f.config), /reconcile-before-retry/);
  });
}

test("only definitive 429 retries, with bounded attempts", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  f.config.telegram.sendMessage = async () => { if (++calls < 3) throw apiError(429, 1); return sent; };
  const result = await sendBackgroundNotification(f.config);
  assert.equal(result.ok, true); assert.equal(calls, 3); assert.equal(result.attempts.length, 3);
});

test("exhausted 429 stays failed; explicit retry reuses history", async (t) => {
  const f = await fixture(t);
  f.config.telegram.sendMessage = async () => { throw apiError(429, 1); };
  const result = await sendBackgroundNotification(f.config);
  assert.equal(result.ok, false); assert.equal(result.status, "failed");
  assert.equal(result.attempts.length, 3);
  f.config.telegram.sendMessage = async () => sent;
  const retried = await sendBackgroundNotification(f.config);
  assert.equal(retried.ok, true); assert.equal(retried.attempts.length, 4);
});

for (const error of [Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }), apiError(500)]) {
  test(`ambiguous ${error.code || error.response.error_code} is not replayed`, async (t) => {
    const f = await fixture(t);
    let calls = 0;
    f.config.telegram.sendMessage = async () => { calls++; throw error; };
    assert.equal((await sendBackgroundNotification(f.config)).status, "uncertain");
    assert.equal(calls, 1);
    await assert.rejects(sendBackgroundNotification(f.config), /reconcile-before-retry/);
  });
}

test("definitive 403 is recorded as failed, never sent", async (t) => {
  const f = await fixture(t);
  f.config.telegram.sendMessage = async () => { throw apiError(403); };
  const result = await sendBackgroundNotification(f.config);
  assert.equal(result.status, "failed"); assert.equal(result.ok, false);
  assert.equal((await f.receipt()).deliveryEvidence, "not_sent");
});

test("changed payload cannot reuse or overwrite a sent receipt", async (t) => {
  const f = await fixture(t);
  await sendBackgroundNotification(f.config);
  await assert.rejects(sendBackgroundNotification({ ...f.config, text: "different" }), /identity-mismatch/);
  assert.equal((await f.receipt()).status, "sent"); assert.equal(f.calls.length, 1);
});

test("concurrent attempts and crash-left locks fail closed", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(`${f.config.receiptPath}.lock`, "");
  await assert.rejects(sendBackgroundNotification(f.config), { code: "EEXIST" });
  assert.equal(f.calls.length, 0);
});

test("unsafe text and symlink receipts do not send", async (t) => {
  const f = await fixture(t);
  await assert.rejects(sendBackgroundNotification({ ...f.config, text: "x".repeat(4001) }));
  const original = path.join(f.root, "original.json");
  await fs.writeFile(original, "{}");
  await fs.symlink(original, f.config.receiptPath);
  await assert.rejects(sendBackgroundNotification(f.config), /not-regular/);
  assert.equal(f.calls.length, 0); assert.equal(await fs.readFile(original, "utf8"), "{}");
});

test("CLI help and unknown arguments cannot enter a send boundary", async () => {
  const run = promisify(execFile);
  const file = path.resolve("scripts/send-background-notification.mjs");
  const help = await run(process.execPath, [file, "--help"], { cwd: os.tmpdir() });
  assert.match(help.stdout, /expected-bot-id/);
  await assert.rejects(run(process.execPath, [file, "--wrong-option"]));
});
