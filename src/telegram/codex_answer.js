import { extractTelegramPhotoArtifacts, formatRejectedPhotoArtifacts } from "./attachments.js";
import { summarizeTelegramError } from "./api.js";
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

  if (typeof replyHtml !== "function") throw new TypeError("replyHtml option is required.");
  if (typeof replyLong !== "function") throw new TypeError("replyLong option is required.");

  let answerText = String(text ?? "");
  const artifactResult = await extractPhotoArtifacts(answerText);
  answerText = appendRejectedPhotoArtifacts(artifactResult.text, artifactResult.rejected);

  if (format === "off") {
    if (answerText) await replyLong(ctx, answerText);
    await replyPhotosWithFallback(ctx, artifactResult.photos, replyPhotos, replyHtml);
    return;
  }

  if (format === "markdown") {
    const richResult = answerText
      ? await tryRichMarkdown(ctx, answerText, { logger: richLogger })
      : { sent: false };
    if (richResult.sent) {
      await replyPhotosWithFallback(ctx, artifactResult.photos, replyPhotos, replyHtml);
      return;
    }
  }

  const max = Math.max(500, maxTelegramChars);
  if (answerText) {
    for (const chunk of splitMarkdownAware(answerText, max)) {
      const html = format === "markdown"
        ? formatCodexAnswerMarkdownHtml(chunk)
        : formatCodexAnswerSafeHtml(chunk);
      await replyHtml(ctx, html);
    }
  }
  await replyPhotosWithFallback(ctx, artifactResult.photos, replyPhotos, replyHtml);
}

function appendRejectedPhotoArtifacts(text, rejected) {
  const rejectionText = formatRejectedPhotoArtifacts(rejected);
  if (!rejectionText) return String(text ?? "");
  const body = String(text ?? "").trim();
  return body ? `${body}\n\n${rejectionText}` : rejectionText;
}

async function replyPhotosWithFallback(ctx, photos, replyPhotos, replyHtml) {
  await replyPhotos(ctx, photos, {
    onError: async (photo, error) => {
      const message = summarizeTelegramError(error).description;
      const text = [
        "Photo upload failed. File remains on disk:",
        `\`${photo.path}\``,
        `\`${message}\``
      ].join("\n");
      await replyHtml(ctx, formatCodexAnswerSafeHtml(text));
    }
  });
}
