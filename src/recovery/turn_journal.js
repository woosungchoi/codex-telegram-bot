import { createHash } from "node:crypto";
import { STREAM_IDLE_TIMEOUT_MESSAGE } from "../codex/watchdog.js";
import { b } from "../telegram/html.js";
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
import { appendRecoveryJournal, summarizeStreamEvent } from "./journal.js";
import {
  applyRecoveryThreadToChatState,
  clearCompletedRecovery,
  markRecoveryAttempt
} from "./startup.js";
import {
  ensureRecoveryDir,
  removeActiveTurnSnapshot,
  replaceActiveTurnSnapshot,
  upsertActiveTurnSnapshot
} from "./state.js";

export function createTurnRecoveryJournal({
  settings,
  state,
  activeTurns,
  threadCache,
  chats,
  options,
  persistence,
  telegram,
  formatting,
  text: t,
  logger = console,
  now = () => new Date()
}) {
  async function recordActiveTurnStarted(chatKey, turn) {
    if (!settings.enabled) return;
    const effective = options.get(chatKey);
    const timestamp = now().toISOString();
    const snapshot = {
      chatKey,
      chatId: turn.chatId ?? chatKey,
      messageThreadId: turn.messageThreadId,
      replyToMessageId: turn.replyToMessageId,
      originMessageId: turn.originMessageId,
      originUpdateId: turn.originUpdateId,
      queueItemId: turn.id || "",
      threadId: chats.get(chatKey).threadId || "",
      inputTextDigest: digestText(turn.inputText || turn.text || ""),
      inputPreview: formatting.truncate(
        String(turn.text || turn.inputText || "").replace(/\s+/g, " "),
        240
      ),
      workingDirectory: effective.workingDirectory || settings.defaultWorkdir,
      model: effective.model || settings.defaultModel || "",
      serviceTier: effective.serviceTier || "default",
      startedAt: timestamp,
      lastEventAt: timestamp,
      lastKnownStatus: "running",
      recoveryEligible: turn.kind !== "recovery",
      recoveryReason: turn.kind === "recovery" ? "recovery_turn" : ""
    };
    await safeRecoveryWrite(async () => {
      await replaceActiveTurnSnapshot(settings.recoveryDir, chatKey, snapshot);
      await appendRecoveryEvent({
        type: "turn_started",
        chatKey,
        queueItemId: turn.id || "",
        recoveryEligible: snapshot.recoveryEligible
      });
    });
  }

  async function recordThreadStarted(chatKey, threadId) {
    if (!settings.enabled) return;
    await safeRecoveryWrite(async () => {
      await updateSnapshot(chatKey, {
        lastKnownStatus: "thread_started",
        threadId
      });
      await appendRecoveryEvent({ type: "thread_started", chatKey, threadId });
    });
  }

  async function recordStreamItemEvent(chatKey, event, update = {}) {
    if (!settings.enabled) return;
    const summary = summarizeStreamEvent(event);
    const completed = update.eventType === "item.completed" || event.type === "item.completed";
    await safeRecoveryWrite(async () => {
      await updateSnapshot(chatKey, {
        lastCompletedItemType: completed ? summary.itemType : undefined,
        lastCompletedItemId: completed ? summary.itemId : undefined,
        lastKnownStatus: summary.eventType || event.type || "unknown"
      });
      await appendRecoveryEvent({ type: "stream_item", chatKey, ...summary });
    });
  }

  async function recordCodexStreamStarted(chatKey, turnKind) {
    if (!settings.enabled) return;
    await safeRecoveryWrite(async () => {
      await updateSnapshot(chatKey, {
        lastKnownStatus: "codex_stream_started",
        streamTurnKind: turnKind || ""
      });
      await appendRecoveryEvent({
        type: "codex_stream_started",
        chatKey,
        turnKind: turnKind || ""
      });
    });
  }

  async function recordCodexStreamFirstItem(chatKey, event, update, elapsedMs) {
    if (!settings.enabled) return;
    const summary = summarizeStreamEvent(event);
    await safeRecoveryWrite(async () => {
      await updateSnapshot(chatKey, {
        lastKnownStatus: "codex_stream_first_item",
        firstItemType: update.item?.type || summary.itemType || "",
        firstItemEventType: update.eventType || summary.eventType || event.type || ""
      });
      await appendRecoveryEvent({
        type: "codex_stream_first_item",
        chatKey,
        elapsedMs,
        ...summary
      });
    });
  }

  async function recordCodexStreamFinalResponseSeen(chatKey, length, elapsedMs) {
    if (!settings.enabled) return;
    await safeRecoveryWrite(async () => {
      await updateSnapshot(chatKey, {
        lastKnownStatus: "codex_stream_final_response_seen",
        finalResponseLength: length,
        finalResponseSeenAt: now().toISOString()
      });
      await appendRecoveryEvent({
        type: "codex_stream_final_response_seen",
        chatKey,
        elapsedMs,
        length
      });
    });
  }

  async function recordCodexStreamIteratorClosed(chatKey, metadata) {
    if (!settings.enabled) return;
    await safeRecoveryWrite(async () => {
      await updateSnapshot(chatKey, {
        lastKnownStatus: "codex_stream_iterator_closed",
        streamOutcome: metadata.outcome || ""
      });
      await appendRecoveryEvent({
        type: "codex_stream_iterator_closed",
        chatKey,
        ...metadata
      });
    });
  }

  async function recordCodexStreamUnknownEvent(chatKey, event, elapsedMs) {
    if (!settings.enabled) return;
    await safeRecoveryWrite(async () => {
      await appendRecoveryEvent({
        type: "codex_stream_unknown_event",
        chatKey,
        elapsedMs,
        ...summarizeStreamEvent(event)
      });
    });
  }

  async function recordCodexStreamBackfill(chatKey, metadata) {
    if (!settings.enabled) return;
    await safeRecoveryWrite(async () => {
      await updateSnapshot(chatKey, {
        lastKnownStatus: metadata.recovered
          ? "codex_stream_backfilled"
          : "codex_stream_backfill_missed",
        backfillSource: metadata.source || "",
        backfillEventCount: metadata.eventCount ?? 0,
        backfillFinalResponseLength: metadata.finalResponseLength ?? 0
      });
      await appendRecoveryEvent({
        type: metadata.recovered ? "codex_stream_backfilled" : "codex_stream_backfill_missed",
        chatKey,
        ...metadata,
        status: formatting.truncate(metadata.status || "", 500)
      });
    });
  }

  async function recordStreamIdleNotice(ctx, chatKey, idleMs, isRecoveryTurn) {
    if (!settings.enabled) return;
    await safeRecoveryWrite(async () => {
      await updateSnapshot(chatKey, {
        lastKnownStatus: "stream_idle_notice",
        streamIdleMs: idleMs
      });
      await appendRecoveryEvent({
        type: "stream_idle_notice",
        chatKey,
        idleMs,
        recovery: isRecoveryTurn
      });
    });
    if (isRecoveryTurn) {
      await telegram.replyHtml(
        ctx,
        `${b(t("recoveryIdleTitle"))}\n${t("recoveryIdleDetail")}`
      ).catch(() => {});
    }
  }

  async function recordStreamIdleTimeout(chatKey, idleMs) {
    if (!settings.enabled) return;
    await safeRecoveryWrite(async () => {
      await updateSnapshot(chatKey, {
        lastKnownStatus: STREAM_IDLE_TIMEOUT_MESSAGE,
        recoveryEligible: false,
        recoveryReason: STREAM_IDLE_TIMEOUT_MESSAGE,
        streamIdleMs: idleMs
      });
      await appendRecoveryEvent({ type: STREAM_IDLE_TIMEOUT_MESSAGE, chatKey, idleMs });
    });
  }

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

  async function restoreRecoveryThreadForTurn(chatKey, turn) {
    const recoveryThreadId = String(turn?.recovery?.threadId || "").trim();
    if (!recoveryThreadId) return;
    const chat = chats.get(chatKey);
    const changed = applyRecoveryThreadToChatState(chat, turn);
    const cached = threadCache.get(chatKey);
    if (cached && cached.id !== recoveryThreadId) threadCache.delete(chatKey);
    if (!changed) return;
    await persistence.save();
    await appendRecoveryEvent({
      type: "recovery_thread_restored",
      chatKey,
      threadId: recoveryThreadId,
      recoveryKey: turn.recovery?.recoveryKey || ""
    });
  }

  async function recordActiveTurnCompleted(chatKey, threadId) {
    if (!settings.enabled) return;
    await safeRecoveryWrite(async () => {
      await appendRecoveryEvent({ type: "turn_completed", chatKey, threadId });
      await removeActiveTurnSnapshot(settings.recoveryDir, chatKey);
      const active = activeTurns.get(chatKey);
      if (active?.currentPreparedTurn?.kind === "recovery") {
        await markRecoveryAttempt(
          settings.recoveryDir,
          active.currentPreparedTurn.recovery || { chatKey, threadId },
          { status: "completed" }
        );
        await clearCompletedRecovery(settings.recoveryDir);
      }
    });
  }

  async function recordActiveTurnFailed(chatKey, message) {
    if (!settings.enabled) return;
    await safeRecoveryWrite(async () => {
      await updateSnapshot(chatKey, {
        lastKnownStatus: "failed",
        recoveryEligible: false,
        recoveryReason: message
      });
      await appendRecoveryEvent({
        type: "turn_failed",
        chatKey,
        message: formatting.truncate(message, 500)
      });
      const active = activeTurns.get(chatKey);
      if (active?.currentPreparedTurn?.kind === "recovery") {
        await markRecoveryAttempt(
          settings.recoveryDir,
          active.currentPreparedTurn.recovery || { chatKey },
          { status: "failed" }
        );
      }
    });
  }

  async function markActiveTurnStopped(chatKey) {
    if (!settings.enabled) return;
    await safeRecoveryWrite(async () => {
      await updateSnapshot(chatKey, {
        lastKnownStatus: "stopped",
        recoveryEligible: false,
        recoveryReason: "user_stop"
      });
      await appendRecoveryEvent({ type: "turn_stopped", chatKey });
    });
  }

  async function appendRecoveryEvent(event) {
    await appendRecoveryJournal(settings.recoveryDir, event);
  }

  async function safeRecoveryWrite(fn) {
    try {
      await ensureRecoveryDir(settings.recoveryDir);
      await fn();
    } catch (error) {
      logger.warn(
        "recovery journal write failed:",
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  async function updateSnapshot(chatKey, update) {
    await upsertActiveTurnSnapshot(settings.recoveryDir, chatKey, {
      lastEventAt: now().toISOString(),
      ...update
    });
  }

  return {
    appendRecoveryEvent,
    digestText,
    markActiveTurnStopped,
    recordActiveTurnCompleted,
    recordActiveTurnFailed,
    recordActiveTurnStarted,
    recordCodexStreamBackfill,
    recordCodexStreamFinalResponseSeen,
    recordCodexStreamFirstItem,
    recordCodexStreamIteratorClosed,
    recordCodexStreamStarted,
    recordCodexStreamUnknownEvent,
    recordStreamIdleNotice,
    recordStreamIdleTimeout,
    recordStreamItemEvent,
    recordTelegramProgressFailed,
    recordTelegramReplyCompleted,
    recordTelegramReplyDigestMismatch,
    recordTelegramReplyFailed,
    recordTelegramReplyReady,
    recordTelegramReplyStarted,
    recordThreadStarted,
    restoreRecoveryThreadForTurn,
    safeRecoveryWrite
  };
}

function telegramReplyMetadata(text) {
  return {
    digest: digestText(text),
    length: String(text || "").length
  };
}

export function digestText(text) {
  return `sha256:${createHash("sha256").update(String(text)).digest("hex")}`;
}
