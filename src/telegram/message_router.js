import path from "node:path";
import { b, code } from "./html.js";

export function registerTelegramMiddleware({ bot, config, authorize, telegram }) {
  bot.catch(async (error, ctx) => {
    const summary = telegram.summarizeError(error);
    console.error("Unhandled Telegram update error:", summary);
    if (ctx.chat) {
      await telegram.replyHtml(
        ctx,
        `${b("Telegram bot error")}\n${code(summary.description)}`
      ).catch(() => {});
    }
  });

  bot.use(async (ctx, next) => {
    const authorization = authorize(ctx, config);
    if (!authorization.ok) {
      if (ctx.message) await ctx.reply("Unauthorized.");
      return;
    }
    return next();
  });
}

export function registerTelegramMessageRoutes({
  bot,
  input,
  pdf,
  telegram,
  localization,
  commands
}) {
  bot.on("photo", async (ctx) => {
    await input.handleCodexMessage(
      ctx,
      ctx.message.caption?.trim() || "Analyze this image.",
      async () => {
        const photo = ctx.message.photo.at(-1);
        if (!photo) return [];
        return [await input.downloadFile(ctx, photo.file_id, ".jpg")];
      }
    );
  });

  bot.on("document", async (ctx) => {
    const document = ctx.message.document;
    const plan = pdf.planInput(document, ctx.message.caption, {
      imageFallbackText: "Analyze this image."
    });
    if (plan.kind === "pdf_upload_only" || plan.kind === "pdf_caption") {
      let record;
      try {
        record = await input.downloadPdf(ctx, document, ctx.message);
        await input.rememberLastPdfUpload(ctx, record);
      } catch (error) {
        await telegram.replyHtml(
          ctx,
          `${b("Failed to prepare Codex input")}\n${code(error instanceof Error ? error.message : String(error))}`
        );
        return;
      }
      if (plan.kind === "pdf_upload_only") {
        await telegram.replyHtml(ctx, input.formatUploadedPdf(record));
        return;
      }
      await input.handleCodexMessage(
        ctx,
        pdf.mergeReferences(plan.text, [record]),
        async () => []
      );
      return;
    }
    if (plan.kind !== "image") {
      await telegram.replyHtml(ctx, localization.text("unsupportedDocument"));
      return;
    }
    const extension = path.extname(document.file_name ?? "")
      || input.extensionFromMime(document.mime_type);
    await input.handleCodexMessage(ctx, plan.text, async () => (
      [await input.downloadFile(ctx, document.file_id, extension)]
    ));
  });

  bot.on("text", async (ctx) => {
    const text = ctx.message.text.trim();
    if (!text || commands.isRegistered(ctx.message)) return;
    const recentPdf = pdf.shouldUseRecent(text)
      ? input.getFreshLastPdf(input.getChatKey(ctx))
      : null;
    await input.handleCodexMessage(
      ctx,
      recentPdf ? pdf.mergeReferences(text, [recentPdf]) : text,
      async () => []
    );
  });

  bot.on("message", async (ctx) => {
    await telegram.replyHtml(ctx, localization.text("unsupportedMessage"));
  });
}
