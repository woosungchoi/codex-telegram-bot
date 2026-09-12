import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";
import { readTelegramAccessConfig } from "../config/telegram.js";
import { summarizeTelegramError } from "./api.js";

const SCHEMA = "codex.telegram_background_notification.v1";

export async function loadNotificationAccess(appRoot) {
  return readTelegramAccessConfig(dotenv.parse(await fs.readFile(path.join(appRoot, ".env"))));
}

export function notificationTarget({ botId, chatId, threadId = "" }, access) {
  const target = { botId: String(botId || ""), chatId: String(chatId || ""), threadId: String(threadId || "") };
  if (!/^[1-9]\d*$/.test(target.botId)) throw new Error("expected-bot-id-required");
  if (!/^-?[1-9]\d*$/.test(target.chatId)) throw new Error("chat-id-invalid");
  if (target.threadId && (!/^[1-9]\d*$/.test(target.threadId) || !Number.isSafeInteger(Number(target.threadId)))) {
    throw new Error("thread-id-invalid");
  }
  const allowed = target.chatId.startsWith("-") ? access.allowedChatIds : access.allowedUserIds;
  if (!allowed?.has(target.chatId)) throw new Error("notification-target-not-allowed");
  if (access.allowedThreadIds?.size && (!target.threadId || !access.allowedThreadIds.has(target.threadId))) {
    throw new Error("notification-thread-not-allowed");
  }
  return target;
}

export async function sendBackgroundNotification({
  telegram, target, text, receiptPath, now = () => new Date().toISOString(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
}) {
  if (typeof text !== "string" || !text.trim() || text.length > 4000) {
    throw new Error("notification-text-must-be-1-to-4000-characters");
  }
  const identity = { ...target, textSha256: createHash("sha256").update(text).digest("hex") };
  const absoluteReceipt = path.resolve(receiptPath);
  await fs.mkdir(path.dirname(absoluteReceipt), { recursive: true, mode: 0o700 });
  const lockPath = `${absoluteReceipt}.lock`;
  // A crash leaves a lock/sending receipt: reconciliation, not blind retry.
  const lock = await fs.open(lockPath, "wx", 0o600);
  let receipt;
  let requestStarted = false;
  try {
    let previous = null;
    try {
      if (!(await fs.lstat(absoluteReceipt)).isFile()) throw new Error("notification-receipt-not-regular");
      previous = JSON.parse(await fs.readFile(absoluteReceipt, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (previous) {
      if (previous.schema !== SCHEMA || Object.entries(identity).some(([key, value]) => previous[key] !== value)) {
        throw new Error("notification-receipt-identity-mismatch");
      }
      if (previous.status === "sent" && previous.ok === true && previous.messageId > 0) {
        return { ...previous, reused: true };
      }
      if (previous.status !== "failed" || previous.retrySafe !== true) {
        throw new Error("notification-delivery-uncertain-reconcile-before-retry");
      }
    }
    receipt = {
      schema: SCHEMA, ...identity, ok: false, status: "checking_origin",
      startedAt: now(), attempts: [...(previous?.attempts || [])],
      deliveryEvidence: "not_sent", retrySafe: true
    };
    await writeReceipt(absoluteReceipt, receipt);
    const me = await telegram.getMe();
    receipt.botUsername = String(me.username || "");
    receipt.observedBotId = String(me.id);
    if (!me.is_bot || String(me.id) !== target.botId) throw new Error("notification-bot-identity-mismatch");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const entry = { startedAt: now(), status: "sending" };
      receipt.attempts.push(entry);
      Object.assign(receipt, { status: "sending", retrySafe: false });
      await writeReceipt(absoluteReceipt, receipt);
      requestStarted = true;
      let sent;
      try {
        sent = await telegram.sendMessage(target.chatId, text, {
          disable_notification: false,
          link_preview_options: { is_disabled: true },
          ...(target.threadId ? { message_thread_id: Number(target.threadId) } : {})
        });
      } catch (error) {
        const summary = summarizeTelegramError(error);
        Object.assign(entry, { status: "failed", finishedAt: now(), error: summary });
        const rejected = summary.kind === "api" && Number(summary.code) >= 400 && Number(summary.code) < 500;
        requestStarted = !rejected;
        // Only a definitive 429 is automatically retried. Timeouts/5xx may have sent.
        if (rejected && Number(summary.code) === 429 && attempt < 2 && summary.retryAfter >= 0 && summary.retryAfter <= 60) {
          Object.assign(receipt, { status: "retry_wait", retrySafe: true });
          await writeReceipt(absoluteReceipt, receipt);
          await sleep(Math.max(1000, summary.retryAfter * 1000));
          continue;
        }
        throw error;
      }
      if (String(sent?.chat?.id) !== target.chatId || String(sent?.from?.id) !== target.botId
          || String(sent?.message_thread_id || "") !== target.threadId
          || !Number.isSafeInteger(sent?.message_id) || sent.message_id <= 0) {
        throw new Error("notification-response-identity-mismatch");
      }
      Object.assign(entry, { status: "sent", finishedAt: now(), messageId: sent.message_id });
      Object.assign(receipt, {
        ok: true, status: "sent", retrySafe: false, messageId: sent.message_id,
        finishedAt: now(), deliveryEvidence: "telegram_api_accepted", recipientReadConfirmed: false
      });
      await writeReceipt(absoluteReceipt, receipt);
      return { ...receipt, reused: false };
    }
    throw new Error("notification-retry-exhausted");
  } catch (error) {
    if (!receipt) throw error;
    Object.assign(receipt, {
      ok: false, status: requestStarted ? "uncertain" : "failed", retrySafe: !requestStarted,
      deliveryEvidence: requestStarted ? "unknown" : "not_sent",
      finishedAt: now(), error: summarizeTelegramError(error)
    });
    await writeReceipt(absoluteReceipt, receipt);
    return receipt;
  } finally {
    await lock.close();
    await fs.unlink(lockPath);
  }
}

async function writeReceipt(destination, value) {
  const temporary = `${destination}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, destination);
  const directory = await fs.open(path.dirname(destination), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}
