import { b, code } from "../telegram/html.js";

export function createCleanupUi({ telegram, localization, formatting }) {
  async function editCleanupMessage(ctx, html) {
    return telegram.editOrReplyHtml(ctx, html, emptyKeyboard());
  }

  async function editUploadCleanupMessage(ctx, html) {
    return telegram.editOrReplyHtml(ctx, html, emptyKeyboard());
  }

  async function editCleanupProcessingMessage(ctx, action, plan) {
    return telegram.editOrReplyHtml(ctx, formatCleanupProcessingHtml(action, plan), {
      reply_markup: {
        inline_keyboard: [[{
          text: localization.text("cleanupProcessingButton"),
          callback_data: `cleanup:processing:${plan.id}`
        }]]
      }
    });
  }

  function cleanupActionLabel(action) {
    if (action === "quarantine") return localization.text("cleanupActionQuarantine");
    if (action === "delete") return localization.text("cleanupActionDelete");
    if (action === "both") return localization.text("cleanupActionBoth");
    if (action === "ignore") return localization.text("cleanupActionIgnore");
    return action;
  }

  function cleanupCallbackText(action) {
    if (action === "quarantine") return localization.text("cleanupCallbackQuarantine");
    if (action === "delete") return localization.text("cleanupCallbackDelete");
    if (action === "both") return localization.text("cleanupCallbackBoth");
    if (action === "ignore") return localization.text("cleanupCallbackIgnore");
    if (action === "missing") return localization.text("cleanupCallbackMissing");
    if (action === "expired") return localization.text("cleanupCallbackExpired");
    return "";
  }

  async function answerCleanupCallback(ctx, action) {
    try {
      await ctx.answerCbQuery(cleanupCallbackText(action));
    } catch (error) {
      console.warn("cleanup callback answer failed:", telegram.summarizeError(error));
    }
  }

  async function answerUploadCleanupCallback(ctx, status) {
    const text = status === "confirm"
      ? "Deleting selected upload cleanup candidates..."
      : status === "expired_plan"
        ? "Upload cleanup plan expired."
        : status === "processing"
          ? "Upload cleanup is already processing."
          : "Upload cleanup plan not found.";
    try {
      await ctx.answerCbQuery(text);
    } catch (error) {
      console.warn("upload cleanup callback answer failed:", telegram.summarizeError(error));
    }
  }

  function formatCleanupProcessingHtml(action, plan) {
    return [
      b(localization.formatText("cleanupProcessingTitle", {
        action: cleanupActionLabel(action)
      })),
      "",
      localization.text("cleanupProcessingBody"),
      "",
      b(localization.text("cleanupTargets")),
      `- ${localization.text("cleanupQuarantineCandidates")}: ${code(formatting.count(plan.quarantineCandidates.length))}`,
      `- ${localization.text("cleanupPermanentDeleteCandidates")}: ${code(formatting.count(plan.deleteCandidates.length))}`,
      "",
      localization.text("cleanupFinishReplace")
    ].join("\n");
  }

  function formatCleanupIgnoredHtml(plan) {
    return [
      b(localization.text("cleanupIgnoredTitle")),
      "",
      `${localization.text("cleanupQuarantineCandidates")}: ${code(formatting.count(plan.quarantineCandidates.length))}`,
      `${localization.text("cleanupPermanentDeleteCandidates")}: ${code(formatting.count(plan.deleteCandidates.length))}`,
      "",
      localization.text("cleanupNoFilesMoved")
    ].join("\n");
  }

  function formatCleanupResultHtml(action, result, plan = null) {
    const lines = [
      b(localization.formatText("cleanupResultTitle", { action: cleanupActionLabel(action) })),
      "",
      `${localization.text("cleanupResultQuarantined")}: ${code(result.quarantined)}`,
      `${localization.text("cleanupResultDeleted")}: ${code(result.deleted)}`,
      `${localization.text("cleanupResultSkipped")}: ${code(result.skipped)}`,
      `${localization.text("cleanupResultErrors")}: ${code(result.errors.length)}`,
      `manifest: ${code(result.manifest || "none")}`,
      `restore: ${code(result.restoreScript || "none")}`
    ];
    if (plan) {
      lines.push(
        "",
        b(localization.text("cleanupTargetSummary")),
        `- ${localization.text("cleanupQuarantineCandidates")}: ${code(formatting.count(plan.quarantineCandidates.length))}`,
        `- ${localization.text("cleanupPermanentDeleteCandidates")}: ${code(formatting.count(plan.deleteCandidates.length))}`
      );
    }
    if (result.errors.length > 0) {
      lines.push("", ...result.errors.slice(0, 3).map((error) => `- ${code(error)}`));
    }
    return lines.join("\n");
  }

  return {
    answerCleanupCallback,
    answerUploadCleanupCallback,
    editCleanupMessage,
    editCleanupProcessingMessage,
    editUploadCleanupMessage,
    formatCleanupIgnoredHtml,
    formatCleanupResultHtml
  };
}

function emptyKeyboard() {
  return { reply_markup: { inline_keyboard: [] } };
}
