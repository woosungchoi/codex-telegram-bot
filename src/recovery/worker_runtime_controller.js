import { runTelegramFinalDelivery, summarizeTelegramError } from "../telegram/api.js";
import { b, code } from "../telegram/html.js";
import { truncate } from "../utils/text.js";
import {
  isWorkerSnapshotResumeEligible,
  normalizeWorkerDeliveryEntry,
  pruneWorkerDeliveries,
  selectWorkerDeliveryCandidates,
  workerDeliveryDigestMatches
} from "../worker/delivery.js";
import { reconstructCompletedWorkerJob } from "../worker/replay.js";
import { readActiveTurnSnapshots, removeActiveTurnSnapshot } from "./state.js";

export function createWorkerRuntimeRecoveryController({
  settings,
  stateStore,
  queue,
  worker,
  turn,
  telegram,
  text: t,
  logger,
  now
}) {
  async function recoverActiveWorkerJobs({
    source = "startup",
    maxAgeSeconds = settings.recoveryStaleSeconds
  } = {}) {
    const snapshotPayload = await readActiveTurnSnapshots(settings.recoveryDir);
    const snapshots = snapshotPayload.turns ?? {};
    const deliveries = stateStore.getWorkerDeliveries();
    const importantJobIds = new Set(
      Object.values(snapshots)
        .map((snapshot) => String(snapshot?.workerJobId || ""))
        .filter(Boolean)
    );
    for (const [key, rawEntry] of Object.entries(deliveries)) {
      const entry = normalizeWorkerDeliveryEntry(key, rawEntry);
      if (entry && entry.deliveryStatus !== "legacy_unknown") importantJobIds.add(entry.jobId);
    }

    const jobs = await readWorkerJobsForRecovery(deliveries, snapshots, importantJobIds, source);
    const activeSnapshotJobIds = Object.values(snapshots)
      .map((snapshot) => String(snapshot?.workerJobId || ""))
      .filter(Boolean);
    const pruned = pruneWorkerDeliveries(deliveries, {
      jobs,
      activeSnapshotJobIds,
      maxAgeSeconds: settings.recoveryTurnTtlSeconds
    });
    if (pruned.removed.length > 0) {
      stateStore.replaceWorkerDeliveries(pruned.deliveries);
      await stateStore.save();
      await turn.appendRecoveryEvent({
        type: "worker_delivery_pruned",
        count: pruned.removed.length
      });
    }

    const selection = selectWorkerDeliveryCandidates(stateStore.getWorkerDeliveries(), jobs, {
      snapshots,
      maxAgeSeconds
    });
    await turn.appendRecoveryEvent({
      type: "worker_delivery_recovery_plan",
      source,
      safe: selection.safe.length,
      manual: selection.manual.length,
      ignored: selection.ignored.length
    });
    for (const candidate of selection.manual) {
      await turn.appendRecoveryEvent({
        type: "worker_delivery_manual_review",
        chatKey: candidate.chatKey,
        jobId: candidate.jobId,
        reason: candidate.reason
      });
    }
    for (const candidate of selection.ignored) {
      if (candidate.reason !== "already_sent" || !candidate.snapshot) continue;
      await removeActiveTurnSnapshot(settings.recoveryDir, candidate.chatKey);
      await turn.appendRecoveryEvent({
        type: "worker_delivery_snapshot_cleaned",
        chatKey: candidate.chatKey,
        jobId: candidate.jobId,
        reason: candidate.reason
      });
    }

    let started = 0;
    for (const [chatKey, snapshot] of Object.entries(snapshots)) {
      const jobId = String(snapshot?.workerJobId || "");
      const job = jobs[jobId];
      if (
        !jobId
        || !isWorkerSnapshotResumeEligible(snapshot, job)
        || stateStore.activeTurns.has(chatKey)
      ) continue;
      if (startWorkerJobRecovery(chatKey, snapshot, job, {
        source,
        expectedDigest: "",
        showProgress: true
      })) started += 1;
    }

    for (const candidate of selection.safe) {
      if (stateStore.activeTurns.has(candidate.chatKey)) {
        await turn.appendRecoveryEvent({
          type: "worker_delivery_recovery_skipped_active",
          chatKey: candidate.chatKey,
          jobId: candidate.jobId
        });
        continue;
      }
      const snapshot = candidate.snapshot
        ?? workerRecoverySnapshot(candidate.chatKey, candidate.job);
      if (startWorkerJobRecovery(candidate.chatKey, snapshot, candidate.job, {
        source,
        expectedDigest: candidate.entry.responseDigest || "",
        showProgress: false,
        completedReplay: true,
        reason: candidate.reason
      })) started += 1;
    }
    return started;
  }

  async function readWorkerJobsForRecovery(deliveries, snapshots, importantJobIds, source) {
    const jobIds = new Set(
      Object.entries(deliveries)
        .map(([key, rawEntry]) => normalizeWorkerDeliveryEntry(key, rawEntry)?.jobId || "")
        .filter(Boolean)
    );
    for (const snapshot of Object.values(snapshots)) {
      const jobId = String(snapshot?.workerJobId || "");
      if (jobId) jobIds.add(jobId);
    }

    const jobs = {};
    await Promise.all([...jobIds].map(async (jobId) => {
      try {
        const result = await worker.getClient().getJobStatus(jobId);
        if (result?.job) jobs[jobId] = result.job;
      } catch (error) {
        if (!importantJobIds.has(jobId)) return;
        await turn.appendRecoveryEvent({
          type: "worker_recovery_unavailable",
          jobId,
          source,
          error: summarizeTelegramError(error)
        });
      }
    }));
    return jobs;
  }

  function startWorkerJobRecovery(chatKey, snapshot, job, options = {}) {
    if (!snapshot || !job?.id || stateStore.activeTurns.has(chatKey)) return false;
    const preparedSnapshot = {
      ...snapshot,
      chatKey,
      workerJobId: job.id,
      workerEventSeq: Number(snapshot.workerEventSeq || 0),
      recoveryEligible: true,
      recoveryReason: options.reason || snapshot.recoveryReason || "worker_recovery"
    };
    const recoveryTurn = createWorkerRecoveryTurn(chatKey, preparedSnapshot);
    const ctx = turn.createSyntheticCtx(recoveryTurn);
    const active = {
      abortController: new AbortController(),
      currentPreparedTurn: recoveryTurn,
      currentQueueItemId: recoveryTurn.id || "",
      currentText: recoveryTurn.text || "",
      currentTurnStartedAt: snapshot.startedAt || now().toISOString(),
      lastProgress: "",
      lastProgressAt: "",
      recoveryEligible: true,
      workerJobId: job.id,
      workerEventSeq: Number(snapshot.workerEventSeq || 0)
    };
    stateStore.activeTurns.set(chatKey, active);
    const liveProgress = options.showProgress ? turn.createLiveProgressState(active) : null;
    if (liveProgress) liveProgress.chatKey = chatKey;
    resumeWorkerJobRecovery(ctx, chatKey, job.id, active, liveProgress, options).catch((error) => {
      logger.warn("worker recovery failed:", summarizeTelegramError(error));
    });
    return true;
  }

  function workerRecoverySnapshot(chatKey, job) {
    return {
      chatKey,
      chatId: job?.chatId ?? chatKey,
      chatType: job?.chatType,
      messageThreadId: job?.messageThreadId,
      replyToMessageId: job?.replyToMessageId,
      originMessageId: job?.originMessageId,
      originUpdateId: job?.originUpdateId,
      queueItemId: job?.id || "",
      threadId: job?.threadId || "",
      inputPreview: "",
      startedAt: job?.startedAt || job?.acceptedAt || "",
      lastEventAt: job?.completedAt || job?.updatedAt || "",
      workerJobId: job?.id || "",
      workerEventSeq: Number(job?.lastSeq || 0),
      workerMode: "sidecar",
      workerTransport: job?.transport || worker.transport(),
      recoveryEligible: true
    };
  }

  async function checkWorkerStartupStatus() {
    try {
      const status = await worker.getClient().status();
      await turn.appendRecoveryEvent({
        type: "worker_startup_status",
        status: status.status || "ok",
        activeJobs: status.activeJobs?.length ?? 0,
        runningJobs: status.runningJobIds?.length ?? 0
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await turn.appendRecoveryEvent({
        type: "worker_startup_status_failed",
        message: truncate(message, 500)
      });
      logger.warn("worker startup status check failed:", message);
    }
  }

  async function resumeWorkerJobRecovery(
    ctx,
    chatKey,
    jobId,
    active,
    liveProgress,
    options = {}
  ) {
    const source = options.source || "startup";
    await turn.appendRecoveryEvent({
      type: "worker_recovery_started",
      chatKey,
      jobId,
      source,
      reason: options.reason || ""
    });
    let finalReaction = "";
    let deliveryCompleted = false;
    try {
      let workerResult;
      try {
        workerResult = options.completedReplay
          ? await reconstructCompletedWorkerJob(worker.getClient(), jobId)
          : await worker.waitForJob(ctx, chatKey, jobId, active, liveProgress, {
            afterSeq: 0,
            turnKind: "recovery"
          });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (active.abortController.signal.aborted || isWorkerCancelledMessage(message)) {
          await turn.markActiveTurnStopped(chatKey);
          await turn.appendRecoveryEvent({
            type: "worker_recovery_cancelled",
            chatKey,
            jobId,
            message: truncate(message, 500)
          });
          finalReaction = settings.stoppedReaction;
        } else {
          await turn.recordActiveTurnFailed(chatKey, message);
          await telegram.replyHtml(
            ctx,
            `${b(t("recoveryStartFailedTitle"))}\n${t("recoveryStartFailedDetail")}\n${code(message)}`
          ).catch(() => {});
          await turn.appendRecoveryEvent({
            type: "worker_recovery_failed",
            chatKey,
            jobId,
            message: truncate(message, 500)
          });
          finalReaction = settings.errorReaction;
        }
        return;
      }

      const execution = {
        ...workerResult,
        executionMode: "sidecar",
        workerJobId: jobId
      };
      if (execution.threadId && stateStore.getChat(chatKey).threadId !== execution.threadId) {
        const chat = stateStore.getChat(chatKey);
        chat.threadId = execution.threadId;
        chat.updatedAt = now().toISOString();
        await stateStore.save();
      }
      const response = turn.formatTurn(execution.turn);
      const replyText = response || "Codex completed without a final message.";
      const actualDigest = turn.digestText(replyText);
      if (!workerDeliveryDigestMatches(options.expectedDigest, actualDigest)) {
        active.stopRequested = true;
        active.deliveryPending = true;
        await turn.recordTelegramReplyDigestMismatch(
          chatKey,
          execution,
          options.expectedDigest,
          actualDigest
        );
        return;
      }

      const delivery = await runTelegramFinalDelivery({
        onReady: () => turn.recordTelegramReplyReady(chatKey, execution, replyText),
        onStarted: () => turn.recordTelegramReplyStarted(chatKey, execution, replyText),
        send: () => telegram.replyCodexAnswer(ctx, replyText),
        onCompleted: () => turn.recordTelegramReplyCompleted(chatKey, execution, replyText),
        onFailed: (error, context) => turn.recordTelegramReplyFailed(
          chatKey,
          execution,
          error,
          { ambiguous: context.requestStarted }
        )
      });
      if (!delivery.ok) {
        active.stopRequested = true;
        active.deliveryPending = true;
        if (delivery.recordError) {
          logger.warn(
            "Worker recovery delivery failure could not be recorded:",
            summarizeTelegramError(delivery.recordError)
          );
        }
        await turn.appendRecoveryEvent({
          type: "worker_recovery_delivery_failed",
          chatKey,
          jobId,
          error: { ...delivery.errorSummary, ambiguous: delivery.requestStarted }
        });
        return;
      }

      await turn.recordActiveTurnCompleted(
        chatKey,
        execution.threadId || stateStore.getChat(chatKey).threadId || ""
      );
      await turn.appendRecoveryEvent({
        type: "worker_recovery_completed",
        chatKey,
        jobId,
        threadId: execution.threadId || ""
      });
      deliveryCompleted = true;
      finalReaction = settings.completeReaction;
    } finally {
      if (liveProgress && turn.shouldDeleteLiveProgress(liveProgress, deliveryCompleted)) {
        await turn.deleteTrackedProgressMessages(ctx, liveProgress);
      }
      await telegram.reactQuietly(
        ctx,
        finalReaction,
        finalReaction === settings.completeReaction
      );
      stateStore.activeTurns.delete(chatKey);
      if (deliveryCompleted) await queue.startDrain(chatKey, ctx);
    }
  }

  return {
    checkWorkerStartupStatus,
    recoverActiveWorkerJobs
  };
}

export function createWorkerRecoveryTurn(chatKey, snapshot, { now = Date.now } = {}) {
  return {
    id: snapshot.queueItemId || `worker-recovery-${snapshot.workerJobId || now()}`,
    chatKey,
    chatId: snapshot.chatId ?? chatKey,
    chatType: snapshot.chatType,
    messageThreadId: snapshot.messageThreadId,
    replyToMessageId: snapshot.replyToMessageId,
    originMessageId: snapshot.originMessageId,
    originUpdateId: snapshot.originUpdateId,
    kind: "recovery",
    text: snapshot.inputPreview || "",
    inputText: "",
    imagePaths: [],
    recovery: {
      chatKey,
      threadId: snapshot.threadId || "",
      recoveryKey: snapshot.recoveryKey || "",
      startedAt: snapshot.startedAt || "",
      lastEventAt: snapshot.lastEventAt || "",
      workerJobId: snapshot.workerJobId || "",
      workerEventSeq: Number(snapshot.workerEventSeq || 0)
    }
  };
}

export function isWorkerCancelledMessage(message) {
  const normalized = String(message || "").toLowerCase();
  return normalized.includes("operation was aborted")
    || normalized.includes("worker job was cancelled")
    || normalized.includes("cancelled by telegram bot");
}
