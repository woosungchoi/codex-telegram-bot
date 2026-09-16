export function normalizeTelegramId(value) {
  if (value == null) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

export function telegramTopicId(meta = {}) {
  const id = normalizeTelegramId(meta.messageThreadId);
  // General is addressed by chat_id alone. Topic 1 in a private chat is valid.
  return id > 0 && !(id === 1 && meta.chatType === "supergroup") ? id : undefined;
}

export function telegramContextMeta(ctx) {
  const message = ctx.message ?? ctx.callbackQuery?.message ?? ctx.msg ?? {};
  return { chatId: ctx.chat?.id ?? ctx.from?.id, chatType: ctx.chat?.type,
    messageThreadId: telegramTopicId({ chatType: ctx.chat?.type, messageThreadId: message.message_thread_id }) };
}

export function telegramChatKey(ctx) {
  const meta = telegramContextMeta(ctx);
  return meta.messageThreadId ? `${meta.chatId}:topic:${meta.messageThreadId}` : String(meta.chatId);
}

export function telegramMetaFromChatKey(key) {
  const match = String(key).match(/^(-?\d+):topic:(\d+)$/);
  return match ? { chatId: Number(match[1]), messageThreadId: Number(match[2]) } : { chatId: key };
}

export function normalizeGeneralTopicUpdate(ctx) {
  const message = ctx.message ?? ctx.callbackQuery?.message;
  if (ctx.chat?.type === "supergroup" && message?.message_thread_id === 1) {
    // Telegraf's reply helpers otherwise automatically send message_thread_id=1.
    delete message.message_thread_id;
  }
}

export function telegramReplyExtraFromMeta(meta = {}, extra = {}) {
  const next = { ...extra };
  const messageThreadId = telegramTopicId(meta);
  const replyToMessageId = normalizeTelegramId(meta.replyToMessageId ?? meta.originMessageId);
  if (messageThreadId != null && next.message_thread_id == null) next.message_thread_id = messageThreadId;
  if (replyToMessageId != null && next.reply_parameters == null && next.reply_to_message_id == null) {
    next.reply_parameters = { message_id: replyToMessageId };
  }
  return next;
}

export function telegramChatActionExtraFromMeta(meta = {}) {
  const messageThreadId = telegramTopicId(meta);
  return messageThreadId == null ? undefined : { message_thread_id: messageThreadId };
}

export function telegramSyntheticMessageFromMeta(meta = {}) {
  const messageThreadId = telegramTopicId(meta);
  return messageThreadId == null ? undefined : {
    message_thread_id: messageThreadId,
    is_topic_message: true
  };
}
