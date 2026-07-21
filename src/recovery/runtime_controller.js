import { createCodexStreamState, codexStreamResult } from "../codex/stream.js";
import { handleRestartCommandCore } from "../restart_command.js";
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
import { createRestartController } from "./controller.js";
import { createRestartMarkerFromActiveTurns } from "./restart.js";
import { handleDirectShutdownSignal } from "./shutdown.js";
import {
  buildStartupRecoveryActions,
  buildStartupRecoveryPlan,
  clearCompletedRecovery,
  clearEmptyRestartMarker,
  clearStaleRestartMarker,
  hasRecoveryStartNoticeBeenSent,
  markRecoveryAttempt,
  markRecoveryStartNoticeSent
} from "./startup.js";
import {
  ensureRecoveryDir,
  isDuplicateRestartUpdate,
  readActiveTurnSnapshots,
  readRecoveryDedupe,
  rememberRestartUpdate,
  removeActiveTurnSnapshot
} from "./state.js";

export function createRuntimeRecoveryController({
  settings,
  stateStore,
  queue,
  worker,
  turn,
  telegram,
  formatting,
  lifecycle,
  text: t,
  sleep,
  logger = console,
  now = () => new Date()
}) {
  let startupRecoveryRunning = false;
  const restartController = createRestartController({
    activeTurns: stateStore.activeTurns,
    exitCode: settings.restartExitCode,
    drainTimeoutSeconds: settings.restartDrainTimeoutSeconds,
    delaySeconds: settings.restartDelaySeconds,
    createMarker: (options) => createRestartMarkerFromActiveTurns(settings.recoveryDir, options),
    appendEvent: turn.appendRecoveryEvent,
    sleep,
    exit: lifecycle.exit,
    logger
  });

  async function startRecoveryScheduler() {
    if (!settings.enabled) return;
    await ensureRecoveryDir(settings.recoveryDir);
    if (worker.enabled()) await checkWorkerStartupStatus();
    await scheduleStartupRecovery({ source: "startup" });
  }

  async function handleProcessSignal(signal) {
    if (signal === "SIGUSR2") {
      await requestRestart({ mode: "sigusr2", requestedBy: "signal", reason: "self_restart" });
      return;
    }
    await handleDirectShutdownSignal({
      signal,
      activeTurns: stateStore.activeTurns,
      recoveryEnabled: settings.enabled,
      recoveryDir: settings.recoveryDir,
      createMarker: createRestartMarkerFromActiveTurns,
      hasRecoverySnapshots: hasPersistedRecoverySnapshots,
      stopBot: lifecycle.stopBot,
      exit: lifecycle.exit,
      logger
    });
  }

  async function hasPersistedRecoverySnapshots() {
    const snapshots = await readActiveTurnSnapshots(settings.recoveryDir);
    return Object.values(snapshots.turns ?? {}).some(
      (snapshot) => snapshot?.recoveryEligible !== false
    );
  }

  async function handleRestartCommand(ctx) {
    await handleRestartCommandCore(ctx, {
      recoveryEnabled: settings.enabled,
      recoveryDisabledText: () => t("recoveryDisabled"),
      isDuplicate: isDuplicateRestartCommandUpdate,
      requestRestart,
      rememberUpdate: (updateId) => rememberRestartUpdate(settings.recoveryDir, updateId),
      reply: telegram.replyHtml,
      formatScheduled: formatting.restartScheduled
    });
  }

  async function isDuplicateRestartCommandUpdate(ctx) {
    const updateId = ctx.update?.update_id;
    const dedupe = await readRecoveryDedupe(settings.recoveryDir);
    if (!isDuplicateRestartUpdate(dedupe, updateId)) return false;
    await turn.appendRecoveryEvent({ type: "restart_duplicate_update_ignored", updateId });
    return true;
  }

  async function requestRestart({ mode, requestedBy, reason, notify = null }) {
    return restartController.requestRestart({ mode, requestedBy, reason, notify });
  }

  async function scheduleStartupRecovery({
    force = false,
    notifyCtx = null,
    source = "manual"
  } = {}) {
    if (!settings.enabled || startupRecoveryRunning) return false;
    startupRecoveryRunning = true;
    let started = 0;
    try {
      if (worker.enabled()) {
        started += await recoverActiveWorkerJobs({
          source,
          maxAgeSeconds: force ? 0 : settings.recoveryStaleSeconds
        });
      }
      const plan = await buildStartupRecoveryPlan(settings.recoveryDir, {
        maxAgeSeconds: force ? 0 : settings.recoveryStaleSeconds,
        suspendAfter: force ? Number.POSITIVE_INFINITY : settings.recoverySuspendAfter,
        reason: source === "startup" ? "startup_recovery" : "manual_recovery",
        excludeWorkerJobs: worker.enabled()
      });
      await turn.appendRecoveryEvent({
        type: "startup_recovery_plan",
        source,
        candidates: plan.candidates.length,
        stale: plan.stale.length,
        suspended: plan.suspended.length
      });
      await notifyRestartMarker(plan.marker);
      await clearEmptyRestartMarker(settings.recoveryDir, plan);
      await clearStaleRestartMarker(settings.recoveryDir, plan);
      for (const candidate of plan.stale) {
        await turn.appendRecoveryEvent({
          type: "recovery_skipped_stale",
          chatKey: candidate.chatKey,
          recoveryKey: candidate.recoveryKey
        });
      }
      for (const candidate of plan.suspended) {
        await turn.appendRecoveryEvent({
          type: "recovery_skipped_suspended",
          chatKey: candidate.chatKey,
          recoveryKey: candidate.recoveryKey,
          attempt: candidate.attempt
        });
      }
      const actions = buildStartupRecoveryActions(plan, {
        activeChatKeys: stateStore.activeTurns.keys(),
        ttlSeconds: settings.recoveryTurnTtlSeconds,
        workingDirectory: settings.workingDirectory
      });
      for (const candidate of actions.skippedActive) {
        await turn.appendRecoveryEvent({
          type: "recovery_skipped_active",
          chatKey: candidate.chatKey,
          recoveryKey: candidate.recoveryKey
        });
      }
      for (const recoveryTurn of actions.turns) {
        const candidate = recoveryTurn.recovery;
        const recoveryCtx = turn.createSyntheticCtx(recoveryTurn);
        try {
          if (await tryCompleteRecoveryFromBackfill(recoveryCtx, recoveryTurn)) {
            started += 1;
            continue;
          }
          await markRecoveryAttempt(settings.recoveryDir, candidate, { status: "started" });
          await notifyRecoveryStarted(recoveryCtx, recoveryTurn);
          await queue.enqueueFrontForced(recoveryTurn.chatKey, recoveryTurn);
          const firstTurn = await queue.dequeue(recoveryTurn.chatKey, recoveryCtx);
          if (!firstTurn) throw new Error("Recovery turn could not be dequeued.");
          await queue.startPrepared(recoveryTurn.chatKey, firstTurn);
          started += 1;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await turn.appendRecoveryEvent({
            type: "recovery_start_failed",
            chatKey: recoveryTurn.chatKey,
            recoveryKey: candidate.recoveryKey || "",
            message: truncate(message, 500)
          });
          await markRecoveryAttempt(settings.recoveryDir, candidate, { status: "failed" });
          await notifyRecoveryStartFailed(recoveryCtx, recoveryTurn, message);
        }
      }
      if (notifyCtx && started === 0) {
        await turn.appendRecoveryEvent({ type: "manual_recovery_no_candidates" });
      }
    } catch (error) {
      logger.warn("startup recovery failed:", error instanceof Error ? error.message : String(error));
      if (notifyCtx) {
        await telegram.replyHtml(
          notifyCtx,
          `${b(t("recoveryFailed"))}\n${code(error instanceof Error ? error.message : String(error))}`
        );
      }
    } finally {
      startupRecoveryRunning = false;
    }
    return started > 0;
  }

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

  async function tryCompleteRecoveryFromBackfill(ctx, recoveryTurn) {
    const candidate = recoveryTurn.recovery || {};
    const threadId = String(candidate.threadId || "").trim();
    if (!threadId) return false;
    const streamState = createCodexStreamState();
    const thread = turn.createCodexThread(recoveryTurn.chatKey, threadId);
    const recovered = await turn.tryBackfillCompletedStream(
      recoveryTurn.chatKey,
      thread,
      streamState,
      {
        sinceMs: Date.parse(candidate.startedAt || candidate.lastEventAt || "") || 0,
        reason: "startup_recovery_preflight"
      }
    );
    if (!recovered) return false;

    const response = turn.formatTurn(codexStreamResult(streamState));
    if (!response) return false;
    await turn.appendRecoveryEvent({
      type: "recovery_completed_from_backfill",
      chatKey: recoveryTurn.chatKey,
      threadId,
      recoveryKey: candidate.recoveryKey || ""
    });
    const execution = {
      turn: codexStreamResult(streamState),
      threadId,
      executionMode: "inline",
      workerJobId: ""
    };
    const delivery = await runTelegramFinalDelivery({
      onReady: () => turn.recordTelegramReplyReady(recoveryTurn.chatKey, execution, response),
      onStarted: () => turn.recordTelegramReplyStarted(recoveryTurn.chatKey, execution, response),
      send: () => telegram.replyCodexAnswer(ctx, response),
      onCompleted: () => turn.recordTelegramReplyCompleted(recoveryTurn.chatKey, execution, response),
      onFailed: (error, context) => turn.recordTelegramReplyFailed(
        recoveryTurn.chatKey,
        execution,
        error,
        { ambiguous: context.requestStarted }
      )
    });
    if (!delivery.ok) {
      if (delivery.recordError) {
        logger.warn(
          "Backfill delivery failure could not be recorded:",
          summarizeTelegramError(delivery.recordError)
        );
      }
      await turn.appendRecoveryEvent({
        type: "recovery_backfill_delivery_failed",
        chatKey: recoveryTurn.chatKey,
        threadId,
        error: { ...delivery.errorSummary, ambiguous: delivery.requestStarted }
      });
      return true;
    }
    await turn.recordActiveTurnCompleted(recoveryTurn.chatKey, threadId);
    await markRecoveryAttempt(settings.recoveryDir, candidate, { status: "completed" });
    await clearCompletedRecovery(settings.recoveryDir);
    return true;
  }

  async function notifyRecoveryStarted(ctx, recoveryTurn) {
    const candidate = recoveryTurn.recovery || { chatKey: recoveryTurn.chatKey };
    if (await hasRecoveryStartNoticeBeenSent(settings.recoveryDir, candidate)) {
      await turn.appendRecoveryEvent({
        type: "recovery_started_notice_skipped",
        chatKey: recoveryTurn.chatKey,
        recoveryKey: candidate.recoveryKey || ""
      });
      return false;
    }
    try {
      const message = await telegram.replyHtml(
        ctx,
        `${b(t("recoveryStartedTitle"))}\n${t("recoveryStartedDetail")}`
      );
      await markRecoveryStartNoticeSent(settings.recoveryDir, candidate);
      await turn.appendRecoveryEvent({
        type: "recovery_started_notice_sent",
        chatKey: recoveryTurn.chatKey,
        recoveryKey: candidate.recoveryKey || "",
        messageId: message?.message_id || ""
      });
      return true;
    } catch (error) {
      await turn.appendRecoveryEvent({
        type: "recovery_started_notice_failed",
        chatKey: recoveryTurn.chatKey,
        recoveryKey: candidate.recoveryKey || "",
        error: summarizeTelegramError(error)
      });
      return false;
    }
  }

  async function notifyRecoveryStartFailed(ctx, _recoveryTurn, message) {
    await telegram.replyHtml(
      ctx,
      `${b(t("recoveryStartFailedTitle"))}\n${t("recoveryStartFailedDetail")}\n${code(message)}`
    ).catch(() => {});
  }

  async function notifyRestartMarker(marker) {
    const notify = marker?.notify;
    if (!notify?.chatId) return;
    try {
      const message = await telegram.sendHtmlMessage(
        notify.chatId,
        formatting.restartRecovered(marker),
        telegram.notifyExtra(notify)
      );
      await turn.appendRecoveryEvent({
        type: "recovery_startup_notice_sent",
        restartId: marker.restartId || "",
        chatKey: String(notify.chatId),
        messageThreadId: notify.messageThreadId || "",
        messageId: message?.message_id || ""
      });
    } catch (error) {
      const errorSummary = summarizeTelegramError(error);
      await turn.appendRecoveryEvent({
        type: "recovery_startup_notice_failed",
        restartId: marker.restartId || "",
        chatKey: String(notify.chatId),
        messageThreadId: notify.messageThreadId || "",
        error: errorSummary
      });
      logger.warn("restart recovery notification failed:", errorSummary);
    }
  }

  return {
    handleProcessSignal,
    handleRestartCommand,
    isRestartScheduled: () => restartController.isScheduled(),
    recoverActiveWorkerJobs,
    requestRestart,
    scheduleStartupRecovery,
    startRecoveryScheduler
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
