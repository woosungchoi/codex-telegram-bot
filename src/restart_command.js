import { requestProvenance } from "./authorization.js";
import { normalizeTelegramId } from "./telegram/context.js";

export function restartCommandRequestFromContext(ctx) {
  return {
    mode: commandName(ctx),
    requestedBy: String(ctx.from?.id ?? "telegram"),
    reason: "self_restart",
    notify: {
      ...requestProvenance(ctx),
      chatId: ctx.chat?.id ?? ctx.from?.id,
      ...telegramMessageMeta(ctx)
    }
  };
}

export async function handleRestartCommandCore(ctx, deps) {
  const recoveryEnabled = typeof deps.recoveryEnabled === "function"
    ? deps.recoveryEnabled()
    : deps.recoveryEnabled;
  if (!recoveryEnabled) {
    await deps.reply(ctx, deps.recoveryDisabledText());
    return { status: "disabled" };
  }
  if (await deps.isDuplicate(ctx)) return { status: "duplicate" };
  const request = restartCommandRequestFromContext(ctx);
  const marker = await deps.requestRestart(request);
  await deps.rememberUpdate(ctx.update?.update_id);
  await deps.reply(ctx, deps.formatScheduled(marker));
  return { status: "scheduled", marker, request };
}

export function telegramMessageMeta(ctx) {
  const message = ctx.message ?? ctx.msg ?? {};
  return {
    chatType: ctx.chat?.type,
    messageThreadId: normalizeTelegramId(message.message_thread_id),
    replyToMessageId: normalizeTelegramId(message.reply_to_message?.message_id),
    originMessageId: normalizeTelegramId(message.message_id),
    originUpdateId: normalizeTelegramId(ctx.update?.update_id)
  };
}

function commandName(ctx) {
  return (ctx.message?.text ?? "").trimStart().split(/\s+/, 1)[0]?.replace(/^\//, "") || "command";
}
