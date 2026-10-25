import { createMessageFormatter } from "../i18n.js";
import { extractTelegramPhotoArtifacts, formatRejectedPhotoArtifacts } from "./attachments.js";
import { summarizeTelegramError } from "./api.js";
import { codeCopyReplyMarkup } from "./copy.js";
import { formatCodexAnswerMarkdownHtml, formatCodexAnswerSafeHtml } from "./markdown.js";
import { replyTelegramPhotos } from "./photo.js";
import { tryReplyRichMarkdown } from "./rich.js";
import { splitMarkdownAware } from "./split.js";

export async function replyFormattedCodexAnswer(ctx, text, options = {}) {
  const {
    extractPhotoArtifacts = extractTelegramPhotoArtifacts,
    format = "markdown",
    maxTelegramChars = 3500,
    replyHtml,
    replyLong,
    replyPhotos = replyTelegramPhotos,
    richLogger = console,
    tryRichMarkdown = tryReplyRichMarkdown
  } = options;

  const msg = createMessageFormatter(options.text);

  if (typeof replyHtml !== "function") throw new TypeError("replyHtml option is required.");
  if (typeof replyLong !== "function") throw new TypeError("replyLong option is required.");

  let answerText = String(text ?? "");
  const artifactResult = await extractPhotoArtifacts(answerText, options.artifactOptions || {});
  const replyMarkup = codeCopyReplyMarkup(artifactResult.text, options.text);
  const copyExtra = replyMarkup ? { reply_markup: replyMarkup } : {};
  answerText = appendRejectedPhotoArtifacts(artifactResult.text, artifactResult.rejected, options.text);

  if (format === "off") {
    if (answerText) await replyLong(ctx, answerText, copyExtra);
    await replyPhotosWithFallback(ctx, artifactResult.photos, replyPhotos, replyHtml, msg);
    return;
  }

  if (format === "markdown") {
    const richResult = answerText
      ? await tryRichMarkdown(ctx, answerText, { logger: richLogger, ...copyExtra })
      : { sent: false };
    if (richResult.sent) {
      await replyPhotosWithFallback(ctx, artifactResult.photos, replyPhotos, replyHtml, msg);
      return;
    }
  }

  const max = Math.max(500, maxTelegramChars);
  if (answerText) {
    const chunks = splitMarkdownAware(answerText, max);
    for (const [index, chunk] of chunks.entries()) {
      const html = format === "markdown"
        ? formatCodexAnswerMarkdownHtml(chunk)
        : formatCodexAnswerSafeHtml(chunk);
      await replyHtml(ctx, html, index === chunks.length - 1 ? copyExtra : {});
    }
  }
  await replyPhotosWithFallback(ctx, artifactResult.photos, replyPhotos, replyHtml, msg);
}

function appendRejectedPhotoArtifacts(text, rejected, translate) {
  const rejectionText = formatRejectedPhotoArtifacts(rejected, translate);
  if (!rejectionText) return String(text ?? "");
  const body = String(text ?? "").trim();
  return body ? `${body}\n\n${rejectionText}` : rejectionText;
}

async function replyPhotosWithFallback(ctx, photos, replyPhotos, replyHtml, msg) {
  await replyPhotos(ctx, photos, {
    onError: async (photo, error) => {
      const message = summarizeTelegramError(error).description;
      const text = [
        msg("ui.photoUploadFailed"),
        `\`${photo.path}\``,
        `\`${message}\``
      ].join("\n");
      await replyHtml(ctx, formatCodexAnswerSafeHtml(text));
    }
  });
}
