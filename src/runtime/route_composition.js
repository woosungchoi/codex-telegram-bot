import { clearCompletedRecovery } from "../recovery/startup.js";
import { authorizeTelegramUpdate } from "../security.js";
import { isCodexSkillsView, replyCodexSkillsStatus } from "../codex/skills_status.js";
import {
  mergePdfReferences,
  planTelegramDocumentInput,
  shouldUseRecentPdfUpload
} from "../telegram/pdf.js";
import { isRegisteredTelegramCommandText } from "../telegram_commands.js";
import {
  confirmUploadCleanupPlan,
  createUploadCleanupResultLogEntry,
  deleteUploadCandidates
} from "../uploads.js";
import { registerAdminCommands } from "../telegram/admin_command_router.js";
import { registerCallbackRoutes } from "../telegram/callback_router.js";
import { registerChatCommands } from "../telegram/chat_command_router.js";
import {
  registerTelegramMessageRoutes,
  registerTelegramMiddleware
} from "../telegram/message_router.js";

export function registerRuntimeRoutes(r) {
  registerTelegramMiddleware({
    bot: r.bot,
    config: r.config,
    authorize: authorizeTelegramUpdate,
    telegram: {
      replyHtml: r.replyHtml,
      summarizeError: r.summarizeTelegramError
    }
  });

  const chatCommandHandlers = registerChatCommands({
    bot: r.bot,
    settings: {
      config: r.config,
      validApprovalPolicies: r.valid.approval,
      validSandboxModes: r.valid.sandbox,
      validWebSearchModes: r.valid.webSearch
    },
    activeTurns: r.activeTurns,
    threadCache: r.threadCache,
    chats: {
      get: r.getChatState,
      getEffectiveOptions: r.getEffectiveOptions,
      invalidateThreadCache: r.invalidateThreadCache,
      rejectIfActive: r.rejectIfActive
    },
    threads: {
      remember: r.rememberThread,
      resume: r.resumeCodexThread,
      start: r.startCodexThread
    },
    sessions: { listRecent: r.listRecentCodexSessions },
    turns: { applyPersonaPrompt: r.applyPersonaPrompt, run: r.runCodexTurn },
    models: {
      formatFastStatus: r.formatFastStatusHtml,
      list: r.listCodexModels,
      sendStandaloneModelSelection: r.sendStandaloneModelSelection,
      sendStandaloneReasoningSelection: r.sendStandaloneReasoningSelection
    },
    options: {
      format: r.formatOptionsHtml,
      updateCommand: r.updateOptionCommand,
      updateValue: r.updateOptionValue
    },
    panels: { helpHtml: r.helpTextHtml, send: r.sendPanel },
    status: {
      buildDetails: r.buildStatusDetails,
      format: r.formatStatusHtml,
      keyboard: r.statusKeyboard
    },
    queue: { pruneExpired: r.pruneExpiredPendingTurns },
    telegram: {
      getChatKey: r.getChatKey,
      getCommandArgs: r.getCommandArgs,
      reactQuietly: r.reactQuietly,
      replyHtml: r.replyHtml
    },
    localization: { text: r.text },
    formatting: { keyValue: r.formatKeyValueHtml, unique: r.unique },
    filesystem: { ensureDirectory: r.ensureDirectory },
    persistence: { save: r.saveState }
  });

  const adminCommandHandlers = registerAdminCommands({
    bot: r.bot,
    settings: {
      config: r.config,
      runtimeValue: r.runtimeValue,
      validQueueModes: r.valid.queueMode
    },
    state: r.state,
    activeTurns: r.activeTurns,
    threadCache: r.threadCache,
    pendingTurns: r.pendingTurns,
    chats: {
      get: r.getChatState,
      invalidateThreadCache: r.invalidateThreadCache,
      rejectIfActive: r.rejectIfActive
    },
    panels: { send: r.sendPanel },
    diagnostics: {
      formatConfig: r.formatConfigHtml,
      formatDoctor: r.formatDoctorHtml,
      formatHealth: r.formatHealthHtml,
      formatLogs: r.formatLogsHtml,
      formatWhoami: r.formatWhoamiHtml
    },
    skills: { replyStatus: replyCodexSkillsStatus },
    backup: { createChatExport: r.createChatExport, createState: r.createStateBackup },
    recovery: {
      cancelWorkerJobOnce: r.cancelWorkerJobOnce,
      clearCompleted: clearCompletedRecovery,
      clearPendingTurns: r.clearRecoveryPendingTurns,
      formatStatus: r.formatRecoveryStatusHtml,
      handleRestartCommand: r.handleRestartCommand,
      markActiveTurnStopped: r.markActiveTurnStopped,
      scheduleStartup: r.scheduleStartupRecovery
    },
    queue: {
      clearPending: r.clearPendingTurns,
      format: r.formatQueueHtml,
      formatMode: r.formatQueueModeHtml,
      keyboard: r.queueKeyboard,
      pruneExpired: r.pruneExpiredPendingTurns,
      removePending: r.removePendingTurn,
      setMode: r.setQueueMode,
      setPaused: r.setQueuePaused,
      startDrain: r.startQueueDrainIfIdle,
      stopSideTurns: r.stopSideTurns
    },
    cleanup: {
      appendLog: r.appendCleanupLog,
      createPlan: r.createCleanupPlan,
      createUploadPlan: r.createUploadCleanupPlan,
      createUploadPlanLogEntry: r.createUploadCleanupPlanLogEntry,
      createUploadPlanRecord: r.createUploadCleanupPlanRecord,
      formatUploadPlan: r.formatUploadCleanupPlanHtml,
      sendPlan: r.sendCleanupPlan,
      uploadKeyboard: r.uploadCleanupKeyboard
    },
    telegram: {
      editOrReplyHtml: r.editOrReplyHtml,
      getChatKey: r.getChatKey,
      getCommandArgs: r.getCommandArgs,
      replyDocument: r.replyDocumentQuietly,
      replyHtml: r.replyHtml
    },
    localization: { text: r.text },
    formatting: {
      bytes: r.formatBytes,
      formatPrefs: r.formatPrefsHtml,
      keyValue: r.formatKeyValueHtml
    },
    persistence: { save: r.saveState }
  });

  registerCallbackRoutes({
    bot: r.bot,
    settings: { config: r.config, runtimeValue: r.runtimeValue },
    state: r.state,
    threadCache: r.threadCache,
    pendingTurns: r.pendingTurns,
    usageRefreshes: r.usageRefreshes,
    cleanup: {
      answerCallback: r.answerCleanupCallback,
      answerUploadCallback: r.answerUploadCleanupCallback,
      appendLog: r.appendCleanupLog,
      applyPlan: r.applyCleanupPlan,
      confirmUploadPlan: confirmUploadCleanupPlan,
      createUploadResultLogEntry: createUploadCleanupResultLogEntry,
      deleteUploadCandidates,
      editMessage: r.editCleanupMessage,
      editProcessingMessage: r.editCleanupProcessingMessage,
      editUploadMessage: r.editUploadCleanupMessage,
      formatDateTime: r.formatDateTime,
      formatIgnored: r.formatCleanupIgnoredHtml,
      formatResult: r.formatCleanupResultHtml,
      formatUploadProcessing: r.formatUploadCleanupProcessingHtml,
      formatUploadResult: r.formatUploadCleanupResultHtml
    },
    queue: {
      clear: r.clearPendingTurns,
      format: r.formatQueueHtml,
      keyboard: r.queueKeyboard,
      move: r.movePendingTurn,
      pruneExpired: r.pruneExpiredPendingTurns,
      remove: r.removePendingTurn,
      sideTurnCount: r.getSideTurnCount
    },
    selection: {
      handleMenuClose: r.handleMenuClose,
      handleSettingsModel: r.handleSettingsModelSelection,
      handleSettingsReasoning: r.handleSettingsReasoningSelection,
      handleStandaloneCancel: r.handleStandaloneSelectionCancel,
      handleStandaloneFast: r.handleStandaloneFastSelection,
      handleStandaloneModel: r.handleStandaloneModelSelection,
      handleStandaloneReasoning: r.handleStandaloneReasoningSelection
    },
    panels: { send: r.sendPanel, settingsHtml: r.settingsPanelHtml },
    callbacks: {
      handleQueue: r.handleQueueButton,
      handleSetting: r.handleSettingButton,
      handleTool: r.handleToolButton
    },
    skills: { isView: isCodexSkillsView, replyStatus: replyCodexSkillsStatus },
    commands: {
      handleNew: chatCommandHandlers.handleNewCommand,
      handleRestart: r.handleRestartCommand,
      handleResume: chatCommandHandlers.handleResumeCommand,
      handleStop: adminCommandHandlers.handleStopCommand
    },
    chats: {
      get: r.getChatState,
      invalidateThreadCache: r.invalidateThreadCache,
      rejectCallbackIfActive: r.rejectCallbackIfActive
    },
    usage: { refreshSample: r.refreshUsageSample },
    status: {
      buildDetails: r.buildStatusDetails,
      format: r.formatStatusHtml,
      keyboard: r.statusKeyboard
    },
    telegram: {
      editOrReplyHtml: r.editOrReplyHtml,
      getChatKey: r.getChatKey,
      replyHtml: r.replyHtml,
      summarizeError: r.summarizeTelegramError
    },
    keyboards: {
      backToMain: r.backToMainKeyboard,
      inline: r.inlineKeyboard,
      settings: r.settingsKeyboard,
      withClose: r.withMenuCloseButton,
      withToolsBack: r.withToolsBack
    },
    localization: { text: r.text },
    persistence: { save: r.saveState },
    timing: { withTimeout: r.withTimeout }
  });

  registerTelegramMessageRoutes({
    bot: r.bot,
    input: {
      downloadFile: r.downloadTelegramFile,
      downloadPdf: r.downloadTelegramPdf,
      extensionFromMime: r.extensionFromMime,
      formatUploadedPdf: r.formatUploadedPdfUploadHtml,
      getChatKey: r.getChatKey,
      getFreshLastPdf: r.getFreshLastPdfUpload,
      handleCodexMessage: r.handleCodexMessage,
      rememberLastPdfUpload: r.rememberLastPdfUpload
    },
    pdf: {
      mergeReferences: mergePdfReferences,
      planInput: planTelegramDocumentInput,
      shouldUseRecent: shouldUseRecentPdfUpload
    },
    telegram: { replyHtml: r.replyHtml },
    localization: { text: r.text },
    commands: { isRegistered: isRegisteredTelegramCommandText }
  });

  return { adminCommandHandlers, chatCommandHandlers };
}
