import { createCodexRuntimeExecutor } from "../codex/runtime_executor.js";
import { createTurnRuntimeController } from "../codex/turn_controller.js";
import { createRuntimeRecoveryController } from "../recovery/runtime_controller.js";
import { createTurnRecoveryJournal } from "../recovery/turn_journal.js";
import { createLiveProgressController } from "../ui/live_progress.js";
import { createWorkerRuntimeController } from "../worker/runtime_controller.js";

export function createExecutionComposition(r) {
  const journal = createTurnRecoveryJournal({
    settings: {
      enabled: r.config.botRestartRecoveryEnabled,
      recoveryDir: r.config.botRecoveryDir,
      defaultWorkdir: r.config.codexWorkdir,
      defaultModel: r.config.codexModel
    },
    state: r.state,
    activeTurns: r.activeTurns,
    threadCache: r.threadCache,
    chats: { get: r.getChatState },
    options: { get: r.getEffectiveOptions },
    persistence: { save: r.saveState },
    telegram: { replyHtml: r.replyHtml },
    formatting: { truncate: r.truncate },
    text: r.text
  });

  const progress = createLiveProgressController({
    settings: { runtimeValue: r.runtimeValue },
    options: { get: r.getEffectiveOptions, defaults: r.defaultChatOptions },
    telegram: {
      getChatKey: r.getChatKey,
      replyTracked: r.replyTrackedProgressHtml
    },
    recovery: { recordProgressFailed: journal.recordTelegramProgressFailed },
    localization: {
      language: r.uiLanguage,
      forLanguage: r.textForLanguage,
      formatForLanguage: r.formatTextForLanguage
    },
    formatting: { redact: r.redactText, truncate: r.truncate }
  });

  const executor = createCodexRuntimeExecutor({
    settings: {
      recoveryEnabled: r.config.botRestartRecoveryEnabled,
      runtimeValue: r.runtimeValue,
      codexPath: r.config.codexPath,
      codexEnv: r.config.codexEnv,
      sessionsDir: r.config.codexSessionsDir,
      contextGuardEnabled: r.config.codexContextGuardEnabled,
      contextCompactThresholdPercent: r.config.codexContextCompactThresholdPercent,
      contextMinRemainingTokens: r.config.codexContextMinRemainingTokens,
      config: r.config
    },
    chats: { get: r.getChatState, save: r.saveState },
    options: { build: r.buildTurnOptions, get: r.getEffectiveOptions },
    threads: {
      start: r.startCodexThread,
      transport: r.threadTransport,
      currentTransport: r.codexTransport
    },
    recovery: {
      appendEvent: journal.appendRecoveryEvent,
      recordActiveTurnFailed: journal.recordActiveTurnFailed,
      recordBackfill: journal.recordCodexStreamBackfill,
      recordFinalResponse: journal.recordCodexStreamFinalResponseSeen,
      recordFirstItem: journal.recordCodexStreamFirstItem,
      recordIdleNotice: journal.recordStreamIdleNotice,
      recordIdleTimeout: journal.recordStreamIdleTimeout,
      recordIteratorClosed: journal.recordCodexStreamIteratorClosed,
      recordStreamItem: journal.recordStreamItemEvent,
      recordStreamStarted: journal.recordCodexStreamStarted,
      recordThreadStarted: journal.recordThreadStarted,
      recordUnknownEvent: journal.recordCodexStreamUnknownEvent
    },
    progress: {
      editMessage: r.editMessageQuietly,
      maybeSend: progress.maybeSendLiveProgress,
      summarize: progress.summarizeProgress
    },
    usage: { readLatestTokenCount: r.readLatestTokenCount },
    telegram: { replyHtml: r.replyHtml },
    formatting: { keyValue: r.formatKeyValueHtml, truncate: r.truncate },
    text: r.text,
    sleep: r.sleep
  });

  const worker = createWorkerRuntimeController({
    settings: {
      recoveryEnabled: r.config.botRestartRecoveryEnabled,
      recoveryDir: r.config.botRecoveryDir,
      eventPollMs: () => r.runtimeValue("codexWorkerEventPollMs")
    },
    deliveryStore: {
      get: (key) => r.state.worker?.deliveries?.[key],
      set: (key, value) => {
        if (!r.state.worker || typeof r.state.worker !== "object") {
          r.state.worker = { deliveries: {} };
        }
        if (!r.state.worker.deliveries || typeof r.state.worker.deliveries !== "object") {
          r.state.worker.deliveries = {};
        }
        r.state.worker.deliveries[key] = value;
      },
      save: r.saveState
    },
    chatStore: { get: r.getChatState, getEffectiveOptions: r.getEffectiveOptions },
    worker: {
      getClient: r.getWorkerClient,
      mode: r.codexWorkerMode,
      transport: r.codexTransport
    },
    turn: {
      createQueueItemId: r.createQueueItemId,
      maybeNotifyContextPressure: executor.maybeNotifyContextPressure,
      maybeSendLiveProgress: progress.maybeSendLiveProgress,
      recordActiveTurnFailed: journal.recordActiveTurnFailed,
      recordCodexStreamFinalResponseSeen: journal.recordCodexStreamFinalResponseSeen,
      recordCodexStreamFirstItem: journal.recordCodexStreamFirstItem,
      recordCodexStreamIteratorClosed: journal.recordCodexStreamIteratorClosed,
      recordCodexStreamStarted: journal.recordCodexStreamStarted,
      recordCodexStreamUnknownEvent: journal.recordCodexStreamUnknownEvent,
      recordStreamItemEvent: journal.recordStreamItemEvent,
      recordThreadStarted: journal.recordThreadStarted
    },
    recovery: {
      appendEvent: journal.appendRecoveryEvent,
      write: journal.safeRecoveryWrite
    },
    sleep: r.sleep
  });

  let recoveryController = null;
  const turn = createTurnRuntimeController({
    settings: {
      maxPendingTurns: () => r.runtimeValue("telegramPendingTurnsMax"),
      pendingTurnMaxAgeSeconds: () => r.runtimeValue("telegramPendingTurnMaxAgeSeconds"),
      thinkingReaction: r.config.telegramThinkingReaction,
      stoppedReaction: r.config.telegramStoppedReaction,
      errorReaction: r.config.telegramErrorReaction,
      completeReaction: r.config.telegramCompleteReaction
    },
    activeTurns: r.activeTurns,
    queue: {
      createItemId: r.createQueueItemId,
      dequeue: r.dequeuePendingTurn,
      enqueue: r.enqueuePendingTurn,
      enqueueFront: r.enqueuePendingTurnFront,
      getMode: r.getQueueMode,
      getPending: r.getPendingTurns,
      hasPendingFinalDelivery: r.hasPendingFinalDelivery,
      isPaused: r.isQueuePaused,
      pruneExpired: r.pruneExpiredPendingTurns
    },
    lifecycle: {
      isRecoveryActive: r.isRecoveryActive,
      isRestartScheduled: () => recoveryController?.isRestartScheduled() ?? false
    },
    context: {
      applyPersonaPrompt: r.applyPersonaPrompt,
      buildReplyContext: r.buildReplyContext,
      ensureTurnContext: r.ensureTurnContext,
      getChatKey: r.getChatKey,
      telegramMessageMeta: r.telegramMessageMeta
    },
    codex: {
      formatTurn: progress.formatTurn,
      getChatThreadId: (chatKey) => r.getChatState(chatKey).threadId,
      getOrCreateThread: r.getOrCreateThread,
      maybeNotifyContextPressure: executor.maybeNotifyContextPressure,
      rememberThread: r.rememberThread,
      runTurn: executor.runCodexTurn,
      startThread: r.startCodexThread
    },
    worker: {
      enabled: r.useWorkerSidecar,
      processPreparedTurn: worker.processPreparedTurnViaWorker
    },
    recovery: {
      recordActiveTurnCompleted: journal.recordActiveTurnCompleted,
      recordActiveTurnFailed: journal.recordActiveTurnFailed,
      recordActiveTurnStarted: journal.recordActiveTurnStarted,
      recordTelegramReplyCompleted: journal.recordTelegramReplyCompleted,
      recordTelegramReplyFailed: journal.recordTelegramReplyFailed,
      recordTelegramReplyReady: journal.recordTelegramReplyReady,
      recordTelegramReplyStarted: journal.recordTelegramReplyStarted,
      restoreThreadForTurn: journal.restoreRecoveryThreadForTurn
    },
    progress: {
      createState: progress.createLiveProgressState,
      deleteMessages: r.deleteTrackedProgressMessages,
      shouldDelete: progress.shouldDeleteLiveProgress
    },
    telegram: {
      reactQuietly: r.reactQuietly,
      replyCodexAnswer: r.replyCodexAnswer,
      replyHtml: r.replyHtml
    },
    status: {
      buildStatusDetails: r.buildStatusDetails,
      formatStatusHtml: r.formatStatusHtml,
      isStatusQuestion: r.isStatusQuestion
    },
    sideTurns: { track: r.trackSideTurn, untrack: r.untrackSideTurn },
    text: r.text
  });

  recoveryController = createRuntimeRecoveryController({
    settings: {
      enabled: r.config.botRestartRecoveryEnabled,
      recoveryDir: r.config.botRecoveryDir,
      recoveryStaleSeconds: r.config.botRecoveryStaleSeconds,
      recoverySuspendAfter: r.config.botRecoverySuspendAfter,
      recoveryTurnTtlSeconds: r.config.botRecoveryTurnTtlSeconds,
      workingDirectory: r.config.codexWorkdir,
      restartExitCode: r.config.botRestartExitCode,
      restartDrainTimeoutSeconds: r.config.botRestartDrainTimeoutSeconds,
      restartDelaySeconds: r.config.botRestartDelaySeconds,
      stoppedReaction: r.config.telegramStoppedReaction,
      errorReaction: r.config.telegramErrorReaction,
      completeReaction: r.config.telegramCompleteReaction
    },
    stateStore: {
      activeTurns: r.activeTurns,
      getWorkerDeliveries: () => r.state.worker?.deliveries ?? {},
      replaceWorkerDeliveries: (deliveries) => {
        r.state.worker.deliveries = deliveries;
      },
      getChat: r.getChatState,
      save: r.saveState
    },
    queue: {
      enqueueFrontForced: async (chatKey, preparedTurn) => {
        r.pendingTurns.set(chatKey, [preparedTurn, ...r.getPendingTurns(chatKey)]);
        await r.persistPendingTurns(chatKey);
      },
      dequeue: r.dequeuePendingTurn,
      startPrepared: turn.startPreparedTurnQueue,
      startDrain: r.startQueueDrainIfIdle
    },
    worker: {
      enabled: r.useWorkerSidecar,
      getClient: r.getWorkerClient,
      waitForJob: worker.waitForWorkerJob,
      transport: r.codexTransport
    },
    turn: {
      appendRecoveryEvent: journal.appendRecoveryEvent,
      createCodexThread: r.createCodexThread,
      createLiveProgressState: progress.createLiveProgressState,
      createSyntheticCtx: r.createSyntheticCtx,
      deleteTrackedProgressMessages: r.deleteTrackedProgressMessages,
      digestText: journal.digestText,
      formatTurn: progress.formatTurn,
      markActiveTurnStopped: journal.markActiveTurnStopped,
      recordActiveTurnCompleted: journal.recordActiveTurnCompleted,
      recordActiveTurnFailed: journal.recordActiveTurnFailed,
      recordTelegramReplyCompleted: journal.recordTelegramReplyCompleted,
      recordTelegramReplyDigestMismatch: journal.recordTelegramReplyDigestMismatch,
      recordTelegramReplyFailed: journal.recordTelegramReplyFailed,
      recordTelegramReplyReady: journal.recordTelegramReplyReady,
      recordTelegramReplyStarted: journal.recordTelegramReplyStarted,
      shouldDeleteLiveProgress: progress.shouldDeleteLiveProgress,
      tryBackfillCompletedStream: executor.tryBackfillCompletedStream
    },
    telegram: {
      notifyExtra: r.telegramNotifyExtra,
      reactQuietly: r.reactQuietly,
      replyCodexAnswer: r.replyCodexAnswer,
      replyHtml: r.replyHtml,
      sendHtmlMessage: r.sendHtmlMessage
    },
    formatting: {
      restartRecovered: r.formatRestartRecoveredHtml,
      restartScheduled: r.formatRestartScheduledHtml
    },
    lifecycle: { stopBot: r.stopBot, exit: r.exit },
    text: r.text,
    sleep: r.sleep
  });

  return {
    cancelWorkerJobOnce: worker.cancelWorkerJobOnce,
    handleCodexMessage: turn.handleCodexMessage,
    handleProcessSignal: recoveryController.handleProcessSignal,
    handleRestartCommand: recoveryController.handleRestartCommand,
    markActiveTurnStopped: journal.markActiveTurnStopped,
    refreshUsageSample: executor.refreshUsageSample,
    runCodexTurn: executor.runCodexTurn,
    runPreparedTurnQueue: turn.runPreparedTurnQueue,
    scheduleStartupRecovery: recoveryController.scheduleStartupRecovery,
    startRecoveryScheduler: recoveryController.startRecoveryScheduler
  };
}
