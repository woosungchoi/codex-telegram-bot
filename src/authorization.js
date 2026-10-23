import { authorizeTelegramUpdate } from "./security.js";

export function authorizationError() {
  return Object.assign(new Error("Stored request is no longer authorized or has incomplete provenance."), {
    code: "quarantined_authorization", suppressTelegramReply: true
  });
}

export function provenanceFields(record = {}) {
  return Object.fromEntries(["inputDirectories", "artifactAccountId", "artifactToken", "artifactTurnId", "artifactCreatedAt", "authorizationVersion", "botId", "requesterUserId", "chatType", "isForum", "accountId"]
    .filter((key) => record[key] !== undefined).map((key) => [key, record[key]]));
}

export function requestProvenance(ctx, accountId = "default") {
  return { authorizationVersion: 1, botId: String(ctx.botInfo?.id || ""),
    requesterUserId: String(ctx.from?.id || ""), chatType: ctx.chat?.type,
    isForum: ctx.chat?.is_forum === true, accountId };
}

export function authorizeStoredRequest(record, config, botId = config.telegramBotToken?.split(":")[0]) {
  if (record?.authorizationVersion !== 1 || !record.requesterUserId || !record.accountId
    || !record.chatId || !record.chatType || !record.botId || !botId
    || String(record.botId) !== String(botId)) return false;
  return authorizeTelegramUpdate({ from: { id: record.requesterUserId },
    chat: { id: record.chatId, type: record.chatType, is_forum: record.isForum === true },
    message: { message_thread_id: record.messageThreadId } }, config).ok;
}

export function assertStoredRequest(record, config, botId) {
  if (!authorizeStoredRequest(record, config, botId)) throw authorizationError();
}

// Each network attempt re-evaluates policy, including Telegram fallback/retry calls.
export function guardTelegramContext(ctx, check) {
  const telegram = new Proxy(ctx.telegram || {}, { get(target, key) {
    const value = target[key];
    return typeof value === "function" ? async (...args) => { check(); return value.apply(target, args); } : value;
  } });
  return new Proxy(ctx, { get(target, key) {
    if (key === "telegram") return telegram;
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? async (...args) => { check(); return value.apply(target, args); } : value;
  } });
}
