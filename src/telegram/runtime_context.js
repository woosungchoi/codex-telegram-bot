import path from "node:path";
import { buildStyleInstructionPrompt } from "../codex/prompts.js";
import { ensurePrivateDirectory, writePrivateFile } from "../fs/private.js";
import {
  createUploadedPdfRecord,
  formatPdfReferenceText,
  formatUploadedPdfHtml,
  isFreshPdfUpload,
  isPdfDocument
} from "./pdf.js";
import {
  normalizeTelegramId,
  telegramChatActionExtraFromMeta,
  telegramReplyExtraFromMeta,
  telegramSyntheticMessageFromMeta
} from "./context.js";

export function createTelegramRuntimeContext({
  bot,
  settings,
  chats,
  persistence,
  localization,
  formatting,
  fetchImpl = globalThis.fetch,
  now = Date.now
}) {
  function telegramNotifyExtra(meta = {}) {
    return telegramReplyExtraFromMeta(meta);
  }

  function createSyntheticCtx(turnOrChatKey) {
    const meta = typeof turnOrChatKey === "object" && turnOrChatKey
      ? turnOrChatKey
      : { chatKey: String(turnOrChatKey), chatId: turnOrChatKey };
    const rawChatId = meta.chatId ?? meta.chatKey;
    const chatId = Number.isNaN(Number(rawChatId)) ? rawChatId : Number(rawChatId);
    const message = telegramSyntheticMessageFromMeta(meta);
    return {
      chat: { id: chatId, type: meta.chatType },
      from: { id: chatId },
      message,
      msg: message,
      telegram: bot.telegram,
      reply: (text, extra = {}) => bot.telegram.sendMessage(
        chatId,
        text,
        telegramReplyExtraFromMeta(meta, extra)
      ),
      sendChatAction: (action) => bot.telegram.sendChatAction(
        chatId,
        action,
        telegramChatActionExtraFromMeta(meta)
      )
    };
  }

  function ensureTurnContext(turn) {
    if (turn.ctx) return turn.ctx;
    turn.ctx = createSyntheticCtx(turn);
    return turn.ctx;
  }

  function telegramMessageMeta(ctx) {
    const message = ctx.message ?? ctx.msg ?? {};
    return {
      chatType: ctx.chat?.type,
      messageThreadId: normalizeTelegramId(message.message_thread_id),
      replyToMessageId: normalizeTelegramId(message.reply_to_message?.message_id),
      originMessageId: normalizeTelegramId(message.message_id),
      originUpdateId: normalizeTelegramId(ctx.update?.update_id)
    };
  }

  async function buildReplyContext(ctx) {
    const message = ctx.message?.reply_to_message;
    if (!message) return { text: "", imagePaths: [] };

    const parts = [];
    const author = message.from?.username
      ? `@${message.from.username}`
      : message.from?.first_name || "unknown";
    const body = message.text || message.caption || "";
    parts.push(`Replied-to Telegram message from ${author}:`);
    parts.push(body || "[no text or caption]");

    const imagePaths = [];
    const photo = message.photo?.at(-1);
    if (photo) imagePaths.push(await downloadTelegramFile(ctx, photo.file_id, ".jpg"));
    const document = message.document;
    if (isPdfDocument(document)) {
      const record = await downloadTelegramPdf(ctx, document, message);
      parts.push("[attached replied-to PDF file]");
      parts.push(formatPdfReferenceText(record));
    } else if (document?.mime_type?.startsWith("image/")) {
      const ext = path.extname(document.file_name ?? "") || extensionFromMime(document.mime_type);
      imagePaths.push(await downloadTelegramFile(ctx, document.file_id, ext));
    }

    if (imagePaths.length > 0) parts.push(`[attached ${imagePaths.length} replied-to image(s)]`);
    return { text: parts.join("\n"), imagePaths };
  }

  function applyPersonaPrompt(text) {
    const personaPrompt = buildStyleInstructionPrompt({
      language: localization.language(),
      personaPrompt: settings.personaPrompt
    });
    if (!personaPrompt) return text;
    return [
      "<style_instruction>",
      personaPrompt,
      "</style_instruction>",
      "",
      text
    ].join("\n");
  }

  async function downloadTelegramFileRecord(ctx, fileId, ext) {
    const link = await ctx.telegram.getFileLink(fileId);
    const response = await fetchImpl(link.href);
    if (!response.ok) throw new Error(`Telegram file download failed: ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (settings.uploadMaxBytes > 0 && bytes.length > settings.uploadMaxBytes) {
      throw new Error(
        `Telegram file exceeds UPLOAD_MAX_BYTES (${formatting.bytes(bytes.length)} > ${formatting.bytes(settings.uploadMaxBytes)}).`
      );
    }
    await ensurePrivateDirectory(settings.uploadDir);
    const filename = `${now()}-${fileId.replace(/[^a-zA-Z0-9_-]/g, "")}${ext}`;
    const filePath = path.join(settings.uploadDir, filename);
    await writePrivateFile(filePath, bytes);
    return { path: filePath, bytes: bytes.length };
  }

  async function downloadTelegramFile(ctx, fileId, ext) {
    const record = await downloadTelegramFileRecord(ctx, fileId, ext);
    return record.path;
  }

  async function downloadTelegramPdf(ctx, document, sourceMessage) {
    const downloaded = await downloadTelegramFileRecord(ctx, document.file_id, ".pdf");
    return createUploadedPdfRecord(document, downloaded, {
      messageId: normalizeTelegramId(sourceMessage?.message_id)
    });
  }

  async function rememberLastPdfUpload(ctx, record) {
    const chat = chats.get(getChatKey(ctx));
    chat.lastPdfUpload = record;
    chat.updatedAt = new Date(now()).toISOString();
    await persistence.save();
  }

  function getFreshLastPdfUpload(chatKey) {
    const record = chats.get(chatKey).lastPdfUpload;
    return isFreshPdfUpload(record);
  }

  function formatUploadedPdfUploadHtml(record) {
    return formatUploadedPdfHtml(record, {
      title: localization.text("pdfUploadedTitle"),
      detail: localization.text("pdfUploadedDetail"),
      labels: {
        file: localization.text("pdfUploadedFile"),
        size: localization.text("pdfUploadedSize"),
        path: localization.text("pdfUploadedPath")
      },
      formatBytes: formatting.bytes
    });
  }

  function getChatKey(ctx) {
    return String(ctx.chat?.id ?? ctx.from?.id);
  }

  function commandName(ctx) {
    return (ctx.message?.text ?? "")
      .trimStart()
      .split(/\s+/, 1)[0]
      ?.replace(/^\//, "") || "command";
  }

  function getCommandArgs(ctx) {
    const text = ctx.message?.text ?? "";
    const commandLength = text.trimStart().split(/\s+/, 1)[0]?.length ?? 0;
    return text.trimStart().slice(commandLength).trim();
  }

  return {
    applyPersonaPrompt,
    buildReplyContext,
    commandName,
    createSyntheticCtx,
    downloadTelegramFile,
    downloadTelegramPdf,
    ensureTurnContext,
    extensionFromMime,
    formatUploadedPdfUploadHtml,
    getChatKey,
    getCommandArgs,
    getFreshLastPdfUpload,
    rememberLastPdfUpload,
    telegramMessageMeta,
    telegramNotifyExtra
  };
}

function extensionFromMime(mime) {
  if (mime === "image/png") return ".png";
  if (mime === "image/webp") return ".webp";
  if (mime === "image/gif") return ".gif";
  return ".jpg";
}
