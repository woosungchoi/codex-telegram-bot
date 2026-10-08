import path from "node:path";
import { validatedPhotoContents } from "./attachments.js";
import { cleanUndefinedPayloadFields, telegramThreadIdFromContext } from "./rich.js";

export async function replyTelegramPhotos(ctx, photos, options = {}) {
  const sent = [];
  for (const photo of photos ?? []) {
    try {
      const message = await ctx.replyWithPhoto(
        { source: validatedPhotoContents(photo), filename: path.basename(photo.path) },
        cleanUndefinedPayloadFields({
          caption: photo.caption,
          message_thread_id: options.message_thread_id ?? telegramThreadIdFromContext(ctx)
        })
      );
      sent.push(message);
    } catch (error) {
      if (typeof options.onError === "function") {
        await options.onError(photo, error);
        continue;
      }
      throw error;
    }
  }
  return sent;
}
