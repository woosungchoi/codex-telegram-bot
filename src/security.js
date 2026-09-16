export function authorizeTelegramUpdate(ctx, config) {
  const userId = String(ctx.from?.id ?? "");
  if (!config.allowedUserIds.has(userId)) return { ok: false, reason: "unauthorized_user" };

  const chatId = chatIdForUpdate(ctx);
  if (config.allowedChatIds?.size > 0 && !config.allowedChatIds.has(String(chatId))) {
    return { ok: false, reason: "disallowed_chat" };
  }

  const threadId = threadIdForUpdate(ctx);
  if (config.allowedThreadIds?.size > 0 && !config.allowedThreadIds.has(String(threadId))) {
    return { ok: false, reason: "disallowed_thread" };
  }

  return { ok: true, reason: "" };
}

function chatIdForUpdate(ctx) {
  return ctx.chat?.id
    ?? ctx.message?.chat?.id
    ?? ctx.callbackQuery?.message?.chat?.id
    ?? "";
}

function threadIdForUpdate(ctx) {
  return ctx.message?.message_thread_id
    ?? ctx.callbackQuery?.message?.message_thread_id
    ?? (ctx.chat?.is_forum ? 1 : undefined)
    ?? "";
}
