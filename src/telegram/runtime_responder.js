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
import { sameRef } from "./progress_store.js";

export function createTelegramRuntimeResponder({ bot, settings, localization, progressStore, logger = console }) {
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
    await trackProgressMessage(ctx, progressState, message);
    return message;
  }

  async function trackProgressMessage(ctx, progressState, message) {
    const chatId = message?.chat?.id ?? ctx.chat?.id;
    const messageId = message?.message_id;
    if (!progressState || !chatId || !messageId) return;
    const ref = { chatId, messageId };
    progressState.messageRefs ||= [];
    if (!progressState.messageRefs.some((existing) => sameRef(existing, ref))) {
      progressState.messageRefs.push(ref);
    }
    await progressStore?.track(progressState, ref);
  }

  async function deleteTrackedProgressMessages(ctx, progressState) {
    if (!progressState) return;
    const refs = [...(progressState.messageRefs || [])];
    for (const ref of progressStore?.getRefs(progressState) || []) {
      if (!refs.some((existing) => sameRef(existing, ref))) refs.push(ref);
    }
    const removed = [];
    try {
      await progressStore?.beginCleanup(progressState);
    } catch (error) {
      logger.warn("Telegram progress cleanup could not be persisted:", summarizeTelegramError(error));
    }
    for (const ref of refs) {
      try {
        await ctx.telegram.deleteMessage(ref.chatId, ref.messageId);
        removed.push(ref);
      } catch (error) {
        const summary = summarizeTelegramError(error);
        if (summary.code === 400 && /message to delete not found|message can't be deleted/i.test(summary.description)) {
          removed.push(ref);
        } else {
          logger.warn("Telegram progress deletion will be retried:", summary);
          // Respect rate limits and leave the rest for a later recovery pass.
          if (summary.code === 429) break;
        }
      }
    }
    progressState.messageRefs = refs.filter((ref) => !removed.some((item) => sameRef(item, ref)));
    try {
      await progressStore?.remove(progressState, removed);
    } catch (error) {
      logger.warn("Telegram progress cleanup result could not be persisted:", summarizeTelegramError(error));
    }
  }

  async function retryPendingProgressCleanup() {
    if (!progressStore) return;
    try {
      await progressStore.prune();
      for (const progressState of progressStore.pending()) {
        await deleteTrackedProgressMessages({ telegram: bot.telegram }, progressState);
      }
    } catch (error) {
      logger.warn("Telegram progress cleanup retry failed:", summarizeTelegramError(error));
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
    retryPendingProgressCleanup,
    sendHtmlMessage,
    trackProgressMessage
  };
}
