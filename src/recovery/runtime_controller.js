import { createCodexStreamState, codexStreamResult } from "../codex/stream.js";
import { handleRestartCommandCore } from "../restart_command.js";
import { runTelegramFinalDelivery, summarizeTelegramError } from "../telegram/api.js";
import { b, code } from "../telegram/html.js";
import { truncate } from "../utils/text.js";
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
} from "./state.js";
import { createWorkerRuntimeRecoveryController } from "./worker_runtime_controller.js";

export {
  createWorkerRecoveryTurn,
  isWorkerCancelledMessage
} from "./worker_runtime_controller.js";

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
  const workerRecovery = createWorkerRuntimeRecoveryController({
    settings,
    stateStore,
    queue,
    worker,
    turn,
    telegram,
    text: t,
    logger,
    now
  });

  async function startRecoveryScheduler() {
    if (!settings.enabled) return;
    await ensureRecoveryDir(settings.recoveryDir);
    if (worker.enabled()) await workerRecovery.checkWorkerStartupStatus();
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
        started += await workerRecovery.recoverActiveWorkerJobs({
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
    recoverActiveWorkerJobs: workerRecovery.recoverActiveWorkerJobs,
    requestRestart,
    scheduleStartupRecovery,
    startRecoveryScheduler
  };
}
