#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Telegraf } from "telegraf";
import { createTelegramApiAgent, summarizeTelegramError } from "../src/telegram/api.js";
import { loadNotificationAccess, notificationTarget, sendBackgroundNotification } from "../src/telegram/background_notification.js";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let agent;
try {
  const { values } = parseArgs({ options: {
    "expected-bot-id": { type: "string" }, "chat-id": { type: "string" },
    "thread-id": { type: "string" }, file: { type: "string" }, receipt: { type: "string" },
    "check-only": { type: "boolean" }, help: { type: "boolean" }
  }, strict: true, allowPositionals: false });
  if (values.help) {
    console.log("Usage: node scripts/send-background-notification.mjs --expected-bot-id ID --chat-id ID [--thread-id ID] --file PATH|- --receipt PATH [--check-only]");
  } else {
    if (!values.file || !values.receipt) throw new Error("file-and-receipt-required");
    // Deliberately ignore inherited TELEGRAM_BOT_TOKEN / Hermes credentials.
    const access = await loadNotificationAccess(appRoot);
    const target = notificationTarget({ botId: values["expected-bot-id"], chatId: values["chat-id"], threadId: values["thread-id"] }, access);
    const text = values.file === "-" ? await readStdin() : await fs.readFile(values.file, "utf8");
    if (!text.trim() || text.length > 4000) throw new Error("notification-text-must-be-1-to-4000-characters");
    agent = createTelegramApiAgent();
    const telegram = new Telegraf(access.telegramBotToken, { telegram: { agent } }).telegram;
    const api = {
      getMe: () => boundedCall(telegram, "getMe", {}),
      sendMessage: (chatId, body, extra) => boundedCall(telegram, "sendMessage", { chat_id: chatId, text: body, ...extra })
    };
    let result;
    if (values["check-only"]) {
      const me = await api.getMe();
      if (!me.is_bot || String(me.id) !== target.botId) throw new Error("notification-bot-identity-mismatch");
      result = { ok: true, ...target, botUsername: me.username, sent: false };
    } else {
      result = await sendBackgroundNotification({ telegram: api, target, text, receiptPath: values.receipt });
    }
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 2;
  }
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: summarizeTelegramError(error) }));
  process.exitCode = 2;
} finally {
  agent?.destroy();
}

async function boundedCall(telegram, method, payload) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try { return await telegram.callApi(method, payload, { signal: controller.signal }); }
  finally { clearTimeout(timeout); }
}

async function readStdin() {
  let text = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    text += chunk;
    if (text.length > 4000) throw new Error("notification-text-too-long");
  }
  return text;
}
