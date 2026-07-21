import path from "node:path";
import { replyFormattedCodexAnswer } from "./codex_answer.js";
import { b, code } from "./html.js";
import {
  editOrReplyTelegramHtml,
  replyTelegramHtml,
  sendTelegramHtml,
  summarizeTelegramError
} from "./api.js";
import { splitText } from "./split.js";

export function createTelegramRuntimeResponder({ bot, settings, localization }) {
  async function replyLong(ctx, text) {
    const max = Math.max(500, settings.runtimeValue("maxTelegramChars"));
    for (const chunk of splitText(text, max)) await ctx.reply(chunk);
  }

  async function replyCodexAnswer(ctx, text) {
    await replyFormattedCodexAnswer(ctx, text, {
      format: settings.runtimeValue("telegramFormatCodexAnswers"),
      maxTelegramChars: settings.runtimeValue("maxTelegramChars"),
      replyHtml,
      replyLong
    });
  }

  async function replyHtml(ctx, html, extra = {}) {
    return replyTelegramHtml(ctx, html, extra, { logger: console });
  }

  async function editOrReplyHtml(ctx, html, extra = {}) {
    return editOrReplyTelegramHtml(ctx, html, extra, { logger: console });
  }

  async function editSelectionMessageStrict(ctx, html, extra) {
    try {
      await editOrReplyTelegramHtml(ctx, html, extra, {
        logger: console,
        replyOnUnavailable: false
      });
      return true;
    } catch (error) {
      console.warn("Telegram selection message edit failed:", summarizeTelegramError(error));
      return false;
    }
  }

  async function answerUiCallback(ctx, edited) {
    try {
      if (edited) await ctx.answerCbQuery();
      else {
        await ctx.answerCbQuery(localization.text("selectionUpdateFailed"), {
          show_alert: true
        });
      }
    } catch (error) {
      console.warn("Telegram UI callback answer failed:", summarizeTelegramError(error));
    }
  }

  async function replyTrackedProgressHtml(ctx, progressState, html) {
    const message = await replyHtml(ctx, html);
    trackProgressMessage(ctx, progressState, message);
    return message;
  }

  function trackProgressMessage(ctx, progressState, message) {
    const chatId = message?.chat?.id ?? ctx.chat?.id;
    const messageId = message?.message_id;
    if (!chatId || !messageId) return;
    progressState.messageRefs.push({ chatId, messageId });
  }

  async function deleteTrackedProgressMessages(ctx, progressState) {
    const refs = progressState?.messageRefs ?? [];
    progressState.messageRefs = [];
    for (const ref of refs) {
      await ctx.telegram.deleteMessage(ref.chatId, ref.messageId).catch(() => {});
    }
  }

  async function replyDocumentQuietly(ctx, filePath, caption) {
    try {
      await ctx.replyWithDocument(
        { source: filePath, filename: path.basename(filePath) },
        { caption }
      );
    } catch (error) {
      await replyHtml(
        ctx,
        `Document upload failed. File remains on disk:\n${code(filePath)}\n${code(summarizeTelegramError(error).description)}`
      );
    }
  }

  async function sendHtmlMessage(chatId, html, extra = {}) {
    return sendTelegramHtml(bot.telegram, chatId, html, extra, { logger: console });
  }

  function helpTextHtml() {
    return [
      b("Codex Telegram Bot"),
      "",
      b(localization.text("commandsCore")),
      code("/menu"),
      code("/new"),
      code("/resume [thread-id|last]"),
      code("/status"),
      code("/queue"),
      code("/settings"),
      code("/tools"),
      code("/skills"),
      code("/stop"),
      code("/help"),
      "",
      b(localization.text("buttonPanels")),
      `${code("/menu")}: ${localization.text("menuHelp")}`,
      `${code("/settings")}: ${localization.text("settingsHelp")}`,
      `${code("/tools")}: ${localization.text("toolsHelp")}`,
      `${code("/queue")}: ${localization.text("queueHelp")}`,
      "",
      b(localization.text("advancedCommands")),
      code("/threads"),
      code("/queue_pause /queue_resume /queue_mode_safe"),
      code("/model /reasoning /sandbox /approval"),
      code("/workdir /adddir /schema"),
      code("/logs /doctor /backup /export /cleanup"),
      "",
      "Inputs: text, Telegram photo, or image document."
    ].join("\n");
  }

  async function reactQuietly(ctx, emoji, isBig = false) {
    if (!settings.runtimeValue("telegramReactionsEnabled") || !emoji || !ctx.message) return;
    try {
      await ctx.react(emoji, isBig);
    } catch (error) {
      console.warn("Telegram reaction failed:", summarizeTelegramError(error));
    }
  }

  async function editMessageQuietly(ctx, messageId, text) {
    try {
      await ctx.telegram.editMessageText(ctx.chat.id, messageId, undefined, text);
    } catch {
      // Progress edits are best-effort.
    }
  }

  return {
    answerUiCallback,
    deleteTrackedProgressMessages,
    editMessageQuietly,
    editOrReplyHtml,
    editSelectionMessageStrict,
    helpTextHtml,
    reactQuietly,
    replyCodexAnswer,
    replyDocumentQuietly,
    replyHtml,
    replyLong,
    replyTrackedProgressHtml,
    sendHtmlMessage,
    trackProgressMessage
  };
}
