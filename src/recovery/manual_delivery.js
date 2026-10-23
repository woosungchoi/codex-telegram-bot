import { runTelegramFinalDelivery } from "../telegram/api.js";
import { code } from "../telegram/html.js";
import { normalizeWorkerDeliveryEntry, workerDeliveryDigestMatches } from "../worker/delivery.js";
import { reconstructCompletedWorkerJob } from "../worker/replay.js";

export function createManualDeliveryController({
  state,
  authorizeJob = null,
  activeTurns,
  getWorkerClient,
  journal,
  telegram,
  startQueueDrain = null,
  formatTurn,
  text,
  logger = console
}) {
  const sending = new Set();

  function unresolved(chatKey) {
    return Object.entries(state.worker?.deliveries ?? {})
      .map(([key, value]) => normalizeWorkerDeliveryEntry(key, value))
      .filter((entry) => entry?.chatKey === chatKey
        && (entry.deliveryStatus === "delivery_failed" || entry.deliveryStatus === "delivery_sending"))
      .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  }

  async function handle(ctx, chatKey, args = "") {
    const entries = unresolved(chatKey);
    const match = /^resend\s+([a-z0-9_-]+)$/i.exec(String(args).trim());
    if (!match) {
      if (String(args).trim()) {
        await telegram.replyHtml(ctx, text("deliveryInvalidCommand"));
      } else if (!entries.length) {
        await telegram.replyHtml(ctx, text("deliveryNoFailures"));
      } else {
        await telegram.replyHtml(ctx, [
          text("deliveryUncertainNotice"),
          ...entries.slice(0, 5).map((entry) => `${code(entry.jobId)} · ${code(entry.updatedAt || "")}`),
          text("deliveryResendHint")
        ].join("\n"));
      }
      return;
    }

    const jobId = match[1];
    const entry = entries.find((item) => item.jobId === jobId);
    if (!entry) {
      await telegram.replyHtml(ctx, text("deliveryJobUnavailable"));
      return;
    }
    if (sending.has(chatKey) || activeTurns.has(chatKey)) {
      await telegram.replyHtml(ctx, text("deliveryBusy"));
      return;
    }
    sending.add(chatKey);
    try {
      const client = getWorkerClient();
      const { job } = await client.getJobStatus(jobId);
      if (!job || String(job.id) !== jobId || String(job.chatKey) !== chatKey || job.status !== "completed") {
        await telegram.replyHtml(ctx, text("deliveryJobUnavailable"));
        return;
      }
      if (authorizeJob) ctx = authorizeJob(ctx, job);
      const reconstructed = await reconstructCompletedWorkerJob(client, jobId);
      const replyText = formatTurn(reconstructed.turn) || text("ui.completedWithoutMessage");
      if (!entry.responseDigest || !workerDeliveryDigestMatches(entry.responseDigest, journal.digestText(replyText))) {
        await telegram.replyHtml(ctx, text("deliveryDigestMismatch"));
        return;
      }
      const execution = { ...reconstructed, executionMode: "sidecar", workerJobId: jobId };
      const result = await runTelegramFinalDelivery({
        onReady: () => journal.recordTelegramReplyReady(chatKey, execution, replyText),
        onStarted: () => journal.recordTelegramReplyStarted(chatKey, execution, replyText),
        send: () => telegram.replyCodexAnswer(ctx, replyText),
        onCompleted: () => journal.recordTelegramReplyCompleted(chatKey, execution, replyText),
        onFailed: (error, context) => journal.recordTelegramReplyFailed(
          chatKey, execution, error, { ambiguous: context.requestStarted }
        )
      });
      if (!result.ok) {
        logger.warn("Manual Telegram delivery failed:", result.errorSummary);
        await telegram.replyHtml(ctx, text("deliveryRetryFailed"));
      }
    } catch (error) {
      logger.warn("Manual delivery reconstruction failed:", error);
      await telegram.replyHtml(ctx, text("deliveryJobUnavailable"));
    } finally {
      sending.delete(chatKey);
      await startQueueDrain?.(chatKey);
    }
  }

  return { handle };
}
