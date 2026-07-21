import { summarizeTelegramError } from "../telegram/api.js";
import {
  markWorkerDeliveryFailed,
  markWorkerDeliveryResultReady,
  markWorkerDeliverySending,
  markWorkerDeliverySent,
  markWorkerDeliveryStreaming,
  normalizeWorkerDeliveryEntry,
  workerDeliveryKey
} from "../worker/delivery.js";

export function createWorkerDeliveryJournal({
  settings,
  state,
  persistence,
  appendRecoveryEvent,
  safeRecoveryWrite,
  updateSnapshot,
  digestText
}) {
  async function recordTelegramReplyReady(chatKey, execution, text) {
    const metadata = telegramReplyMetadata(text);
    await transitionWorkerDelivery(chatKey, execution, (entry) => (
      markWorkerDeliveryResultReady(entry, {
        seq: execution.workerLastSeq ?? entry.seq,
        responseDigest: metadata.digest,
        responseLength: metadata.length
      })
    ));
    if (!settings.enabled) return;
    await safeRecoveryWrite(async () => {
      await updateSnapshot(chatKey, {
        lastKnownStatus: "telegram_reply_ready",
        recoveryEligible: true,
        finalResponseDigest: metadata.digest,
        finalResponseLength: metadata.length
      });
      await appendRecoveryEvent({
        type: "telegram_reply_ready",
        chatKey,
        jobId: execution.workerJobId || "",
        ...metadata
      });
    });
  }

  async function recordTelegramReplyStarted(chatKey, execution, text) {
    const metadata = telegramReplyMetadata(text);
    await transitionWorkerDelivery(chatKey, execution, (entry) => markWorkerDeliverySending(entry));
    if (!settings.enabled) return;
    await safeRecoveryWrite(async () => {
      await updateSnapshot(chatKey, {
        lastKnownStatus: "telegram_delivery_sending",
        recoveryEligible: true,
        finalResponseDigest: metadata.digest,
        finalResponseLength: metadata.length
      });
      await appendRecoveryEvent({
        type: "telegram_reply_started",
        chatKey,
        jobId: execution.workerJobId || "",
        ...metadata
      });
    });
  }

  async function recordTelegramProgressFailed(progressState, event, errorSummary) {
    if (!settings.enabled) return;
    await appendRecoveryEvent({
      type: "telegram_progress_failed",
      chatKey: progressState?.chatKey || "",
      jobId: progressState?.active?.workerJobId || "",
      workerEventSeq: Number(event?.seq || progressState?.active?.workerEventSeq || 0),
      kind: errorSummary?.kind || "unknown",
      code: errorSummary?.code ?? null,
      errno: errorSummary?.errno ?? null
    });
  }

  async function recordTelegramReplyCompleted(chatKey, execution, text) {
    const metadata = telegramReplyMetadata(text);
    await transitionWorkerDelivery(chatKey, execution, (entry) => markWorkerDeliverySent(entry));
    if (!settings.enabled) return;
    await safeRecoveryWrite(async () => {
      await appendRecoveryEvent({
        type: "telegram_reply_completed",
        chatKey,
        jobId: execution.workerJobId || "",
        ...metadata
      });
    });
  }

  async function recordTelegramReplyFailed(chatKey, execution, error, { ambiguous = true } = {}) {
    const errorSummary = { ...summarizeTelegramError(error), ambiguous };
    await transitionWorkerDelivery(
      chatKey,
      execution,
      (entry) => markWorkerDeliveryFailed(entry, errorSummary)
    );
    if (!settings.enabled) return;
    await safeRecoveryWrite(async () => {
      await updateSnapshot(chatKey, {
        lastKnownStatus: "telegram_delivery_failed",
        recoveryEligible: true,
        recoveryReason: "telegram_delivery_failed"
      });
      await appendRecoveryEvent({
        type: "telegram_reply_failed",
        chatKey,
        jobId: execution.workerJobId || "",
        error: errorSummary
      });
    });
  }

  async function recordTelegramReplyDigestMismatch(
    chatKey,
    execution,
    expectedDigest,
    actualDigest
  ) {
    await transitionWorkerDelivery(chatKey, execution, (entry) => markWorkerDeliveryFailed(entry, {
      kind: "integrity",
      code: "RESPONSE_DIGEST_MISMATCH",
      description: "Reconstructed response digest did not match the persisted result.",
      ambiguous: false
    }));
    if (!settings.enabled) return;
    await safeRecoveryWrite(async () => {
      await updateSnapshot(chatKey, {
        lastKnownStatus: "telegram_delivery_digest_mismatch",
        recoveryEligible: true,
        recoveryReason: "telegram_delivery_digest_mismatch"
      });
      await appendRecoveryEvent({
        type: "telegram_reply_digest_mismatch",
        chatKey,
        jobId: execution.workerJobId || "",
        expectedDigest,
        actualDigest
      });
    });
  }

  async function transitionWorkerDelivery(chatKey, execution, transition) {
    if (execution?.executionMode !== "sidecar" || !execution.workerJobId) return null;
    if (!state.worker || typeof state.worker !== "object") state.worker = { deliveries: {} };
    if (!state.worker.deliveries || typeof state.worker.deliveries !== "object") {
      state.worker.deliveries = {};
    }
    const key = workerDeliveryKey(chatKey, execution.workerJobId);
    const normalized = normalizeWorkerDeliveryEntry(key, state.worker.deliveries[key]);
    const current = normalized ?? markWorkerDeliveryStreaming(null, {
      chatKey,
      jobId: execution.workerJobId,
      seq: 0
    });
    const next = transition(current);
    state.worker.deliveries[key] = next;
    await persistence.save();
    return next;
  }

  function telegramReplyMetadata(text) {
    return {
      digest: digestText(text),
      length: String(text || "").length
    };
  }

  return {
    recordTelegramProgressFailed,
    recordTelegramReplyCompleted,
    recordTelegramReplyDigestMismatch,
    recordTelegramReplyFailed,
    recordTelegramReplyReady,
    recordTelegramReplyStarted
  };
}
