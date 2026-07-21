import "dotenv/config";

// Importing this module initializes state and starts the Telegram polling loop.

import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Telegraf } from "telegraf";
import { bootstrapBot } from "./app/bootstrap.js";
import {
  appServerDirectArgs
} from "./codex/app_server.js";
import {
  findCodexModel,
  readCodexModelCatalog,
  reasoningOptionsForModel
} from "./codex/models.js";
import { createChatOptionsController } from "./codex/chat_options_controller.js";
import { createCodexRuntimeExecutor } from "./codex/runtime_executor.js";
import { isCodexSkillsView, replyCodexSkillsStatus } from "./codex/skills_status.js";
import { createTurnRuntimeController } from "./codex/turn_controller.js";
import { resolveAutoCompactTokenLimit } from "./codex/compact.js";
import {
  CODEX_TRANSPORT_APP_SERVER_DIRECT,
  CODEX_TRANSPORT_SDK,
  createCodexThread as createCodexThreadForTransport,
  threadTransport as detectThreadTransport
} from "./codex/thread_factory.js";
import { readConfig as readRuntimeConfig } from "./config.js";
import { TELEGRAM_LANGUAGE_CODES, VALID_LANGUAGES, textFor } from "./i18n.js";
import { createCleanupController } from "./maintenance/cleanup_controller.js";
import { createBackupController } from "./maintenance/backup_controller.js";
import { createCleanupRuntime } from "./maintenance/cleanup_runtime.js";
import { createCodexMaintenanceController } from "./maintenance/runtime_controller.js";
import { createQueueRuntimeController } from "./queue/runtime_controller.js";
import { authorizeTelegramUpdate } from "./security.js";
import {
  createRuntimeSettingsController,
  loadRuntimeState,
  parseRequiredBoolean,
  saveRuntimeState
} from "./runtime/state_store.js";
import { b, code, pre } from "./telegram/html.js";
import {
  createTelegramApiAgent,
  editOrReplyTelegramHtml,
  replyTelegramHtml,
  sendTelegramHtml,
  summarizeTelegramError
} from "./telegram/api.js";
import {
  mergePdfReferences,
  planTelegramDocumentInput,
  shouldUseRecentPdfUpload
} from "./telegram/pdf.js";
import { replyFormattedCodexAnswer } from "./telegram/codex_answer.js";
import { splitText } from "./telegram/split.js";
import { createTelegramRuntimeContext } from "./telegram/runtime_context.js";
import { registerAdminCommands } from "./telegram/admin_command_router.js";
import { registerCallbackRoutes } from "./telegram/callback_router.js";
import { registerChatCommands } from "./telegram/chat_command_router.js";
import {
  registerTelegramMessageRoutes,
  registerTelegramMiddleware
} from "./telegram/message_router.js";
import { isRegisteredTelegramCommandText } from "./telegram_commands.js";
import { createRuntimeStatusSupport } from "./status/runtime_status.js";
import {
  createRuntimeDiagnostics,
  readCommandOutput,
  readJsonFile,
  readPackageJson
} from "./status/runtime_diagnostics.js";
import {
  buildUploadCleanupPlanFromDisk,
  confirmUploadCleanupPlan,
  createUploadCleanupPlanLogEntry,
  createUploadCleanupPlanRecord,
  createUploadCleanupResultLogEntry,
  deleteUploadCandidates,
  shouldRunUploadCleanup
} from "./uploads.js";
import { createRuntimeRecoveryController } from "./recovery/runtime_controller.js";
import { createTurnRecoveryJournal } from "./recovery/turn_journal.js";
import { clearCompletedRecovery } from "./recovery/startup.js";
import {
  createRuntimeKeyboardViews,
  modelSelectionKeyboard,
  reasoningSelectionKeyboard
} from "./ui/keyboards.js";
import {
  LOCALE_CHOICES,
  TIME_ZONE_CHOICES
} from "./ui/preferences.js";
import {
  createSelectionFlowStore
} from "./ui/model_selection_flow.js";
import {
  createAtomicChatOptionsReplacer,
  createModelSelectionController
} from "./ui/model_selection_controller.js";
import {
  createRuntimePanelViews,
  formatKeyValueHtml
} from "./ui/panels.js";
import { createLiveProgressController } from "./ui/live_progress.js";
import { createRuntimePanelController } from "./ui/runtime_panel_controller.js";
import { createSettingsCallbackController } from "./ui/settings_callback_controller.js";
import { createToolCallbackController } from "./ui/tool_callback_controller.js";
import { createWorkerClient } from "./worker/client.js";
import { createWorkerRuntimeController } from "./worker/runtime_controller.js";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VALID = {
  approval: new Set(["never", "on-request", "on-failure", "untrusted"]),
  sandbox: new Set(["read-only", "workspace-write", "danger-full-access"]),
  reasoning: new Set(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]),
  serviceTier: new Set(["fast", "flex"]),
  webSearch: new Set(["disabled", "cached", "live"]),
  codexTransport: new Set([CODEX_TRANSPORT_SDK, CODEX_TRANSPORT_APP_SERVER_DIRECT]),
  codexWorkerMode: new Set(["sidecar", "inline"]),
  queueMode: new Set(["safe", "interrupt", "side"]),
  language: VALID_LANGUAGES,
  liveProgressSource: new Set(["agent", "activity", "both"]),
  liveProgressDeletePolicy: new Set(["always", "on_success", "never"])
};

const config = readRuntimeConfig();
const telegramApiAgent = createTelegramApiAgent();
const bot = new Telegraf(config.telegramBotToken, {
  handlerTimeout: Infinity,
  telegram: { agent: telegramApiAgent }
});
const threadCache = new Map();
const state = await loadRuntimeState(config.stateFile, {
  readFile: fs.readFile,
  defaults: config,
  parseLanguage,
  parseTimeZone,
  parseLocale
});
const saveState = saveRuntimeState;
const {
  runtimeSeconds,
  runtimeValue,
  updateRuntimeSetting
} = createRuntimeSettingsController({
  state,
  defaults: config,
  threadCache,
  save: () => saveState(config.stateFile, state)
});
const activeTurns = new Map();
const pendingTurns = new Map();
const codexClients = new Map();
const sideTurns = new Map();
const usageRefreshes = new Map();
const selectionFlows = createSelectionFlowStore();
let maintenanceController = null;
let adminCommandHandlers = null;
let chatCommandHandlers = null;
const {
  applyPersonaPrompt,
  buildReplyContext,
  commandName,
  createSyntheticCtx,
  downloadTelegramFile,
  downloadTelegramPdf,
  ensureTurnContext,
  extensionFromMime,
  formatUploadedPdfUploadHtml,
  getChatKey,
  getCommandArgs,
  getFreshLastPdfUpload,
  rememberLastPdfUpload,
  telegramMessageMeta,
  telegramNotifyExtra
} = createTelegramRuntimeContext({
  bot,
  settings: {
    personaPrompt: config.codexPersonaPrompt,
    uploadMaxBytes: config.uploadMaxBytes,
    uploadDir: config.uploadDir
  },
  chats: {
    get: (...args) => getChatState(...args)
  },
  persistence: {
    save: () => saveState(config.stateFile, state)
  },
  localization: {
    language: uiLanguage,
    text: t
  },
  formatting: {
    bytes: (...args) => formatBytes(...args)
  }
});
const {
  clearPendingTurns,
  clearRecoveryPendingTurns,
  countPendingTurns,
  countSideTurns,
  createQueueItemId,
  dequeuePendingTurn,
  enqueuePendingTurn,
  enqueuePendingTurnFront,
  getPendingTurns,
  getQueueMode,
  getSideTurnCount,
  hasPendingFinalDelivery,
  hydratePendingTurnsFromState,
  isQueuePaused,
  isRecoveryActive,
  movePendingTurn,
  persistPendingTurns,
  pruneExpiredPendingTurns,
  removePendingTurn,
  setQueueMode,
  setQueuePaused,
  startPersistedQueues,
  startQueueDrainIfIdle,
  stopSideTurns,
  trackSideTurn,
  untrackSideTurn
} = createQueueRuntimeController({
  activeTurns,
  pendingTurns,
  sideTurns,
  settings: {
    maxPendingTurns: () => runtimeValue("telegramPendingTurnsMax"),
    maxPendingAgeSeconds: () => runtimeValue("telegramPendingTurnMaxAgeSeconds")
  },
  chats: {
    get: (...args) => getChatState(...args)
  },
  persistence: {
    save: () => saveState(config.stateFile, state)
  },
  telegram: {
    notifyExpired: (ctx, count) => replyHtml(
      ctx,
      tf("expiredQueuedTurnsCleaned", { count: code(cleanupCount(count)) })
    ),
    createSyntheticContext: (...args) => createSyntheticCtx(...args),
    replyHtml
  },
  turns: {
    runPreparedQueue: (...args) => runPreparedTurnQueue(...args)
  }
});
const {
  approvalKeyboard,
  backToMainKeyboard,
  booleanOptionKeyboard,
  codexMaintenanceBusyKeyboard,
  codexMaintenanceKeyboard,
  emptyInlineKeyboard,
  fastKeyboard,
  inlineKeyboard,
  languageKeyboard,
  liveProgressKeyboard,
  localeKeyboard,
  mainPanelKeyboard,
  pathsKeyboard,
  previousPanelFor,
  queueKeyboard,
  runtimeCleanupKeyboard,
  runtimeCodexKeyboard,
  runtimeKeyboard,
  runtimeOutputKeyboard,
  runtimeQueueKeyboard,
  runtimeSnapshotKeyboard,
  sandboxKeyboard,
  schemaKeyboard,
  settingsKeyboard,
  settingsSelectionKeyboard,
  standaloneFastSelectionKeyboard,
  standaloneModelSelectionKeyboard,
  standaloneReasoningSelectionKeyboard,
  statusKeyboard,
  timeZoneGroupKeyboard,
  timeZoneKeyboard,
  toolsKeyboard,
  uploadCleanupKeyboard,
  webSearchKeyboard,
  withMenuCloseButton,
  withPreviousPanelButton,
  withToolsBack
} = createRuntimeKeyboardViews({
  text: t,
  hasActiveTurn: (chatKey) => activeTurns.has(chatKey),
  sideTurnCount: getSideTurnCount,
  currentLanguage: uiLanguage,
  currentTimeZone: uiTimeZone,
  currentLocale: uiLocale,
  isQueuePaused,
  pendingTurnsFor: getPendingTurns,
  maintenanceAutoHandoffEnabled: () => maintenanceController?.autoHandoffEnabled() ?? false,
  maintenanceAutoSqliteRepairEnabled: () => maintenanceController?.autoSqliteRepairEnabled() ?? false
});
const {
  renderFastPanelHtml,
  renderLiveProgressPanelHtml,
  renderMainPanelHtml,
  renderPathsPanelHtml,
  renderRuntimePanelHtml,
  renderSchemaPanelHtml,
  renderSettingPanelHtml,
  renderSettingsPanelHtml,
  renderTimeZoneGroupPanelHtml,
  renderToolsPanelHtml
} = createRuntimePanelViews({
  text: t,
  formatText: tf
});
const {
  buildTurnOptions,
  defaultChatOptions,
  effectiveModelSlug,
  formatModelSelectionHtml,
  getChatState,
  getEffectiveOptions,
  invalidateThreadCache,
  planRuntimeModelReasoningTransition,
  setOption,
  updateOptionCommand,
  updateOptionValue
} = createChatOptionsController({
  settings: {
    workingDirectory: config.codexWorkdir,
    skipGitRepoCheck: config.codexSkipGitRepoCheck,
    approvalPolicy: config.codexApprovalPolicy,
    sandboxMode: config.codexSandboxMode,
    reasoningEffort: config.codexReasoningEffort,
    webSearchMode: config.codexWebSearch,
    liveProgressEnabled: () => runtimeValue("telegramLiveProgressEnabled"),
    liveProgressSource: config.telegramLiveProgressSource,
    liveProgressDeletePolicy: config.telegramLiveProgressDeletePolicy,
    model: config.codexModel,
    networkAccessEnabled: config.codexNetworkAccess,
    webSearchEnabled: config.codexWebSearchEnabled,
    additionalDirectories: config.codexAdditionalDirectories,
    uploadDir: config.uploadDir
  },
  stateStore: {
    chats: state.chats,
    save: () => saveState(config.stateFile, state)
  },
  threadCache,
  models: {
    list: listCodexModels
  },
  telegram: {
    commandName,
    formatOptionsHtml,
    getChatKey,
    getCommandArgs,
    rejectIfActive,
    replyHtml
  },
  validation: {
    ensureDirectory,
    parseRequiredBoolean,
    validApprovalPolicies: VALID.approval,
    validLiveProgressDeletePolicies: VALID.liveProgressDeletePolicy,
    validLiveProgressSources: VALID.liveProgressSource,
    validSandboxModes: VALID.sandbox,
    validServiceTiers: VALID.serviceTier,
    validWebSearchModes: VALID.webSearch
  },
  text: t
});
const {
  buildAppSummary,
  buildBestCodexUsageSummary,
  buildConfigSummary,
  formatBytes,
  formatDateTime,
  getLocalClock,
  getLocalDateKey,
  readLatestTokenCount
} = createRuntimeStatusSupport({
  settings: {
    config,
    runtimeValue,
    packageFile: path.join(appRoot, "package.json")
  },
  chats: {
    get: getChatState
  },
  packages: {
    readJson: (...args) => readJsonFile(...args),
    readPackage: (...args) => readPackageJson(appRoot, ...args)
  },
  sessions: {
    findFile: (...args) => findCodexSessionFile(...args)
  },
  localization: {
    locale: uiLocale,
    timeZone: uiTimeZone
  },
  formatting: {
    redactValue
  },
  readFile: fs.readFile
});
const {
  buildStatusDetails,
  formatDoctorHtml,
  formatHealthHtml,
  formatQueueHtml,
  formatQueueModeHtml,
  formatRecoveryStatusHtml,
  formatRestartRecoveredHtml,
  formatRestartScheduledHtml,
  formatStatusHtml
} = createRuntimeDiagnostics({
  settings: {
    config,
    runtimeValue,
    packageFile: path.join(appRoot, "package.json")
  },
  state,
  activeTurns,
  threadCache,
  chats: {
    get: getChatState
  },
  options: {
    get: getEffectiveOptions,
    format: formatOptionsHtml
  },
  queue: {
    countPendingTurns,
    countSideTurns,
    isPaused: isQueuePaused,
    mode: getQueueMode,
    pending: getPendingTurns,
    sideTurnCount: getSideTurnCount
  },
  sessions: {
    listRecent: listRecentCodexSessions
  },
  usage: {
    buildSummary: buildBestCodexUsageSummary
  },
  models: {
    list: listCodexModels
  },
  uploads: {
    createCleanupPlan: (...args) => createUploadCleanupPlan(...args)
  },
  localization: {
    text: t,
    formatText: tf,
    locale: uiLocale,
    timeZone: uiTimeZone
  },
  formatting: {
    bytes: formatBytes,
    count: cleanupCount,
    dateTime: formatDateTime,
    duration: formatDurationSeconds,
    keyValue: formatKeyValueHtml,
    truncate
  },
  packages: {
    readJson: readJsonFile,
    readPackage: (...args) => readPackageJson(appRoot, ...args)
  }
});
maintenanceController = createCodexMaintenanceController({
  settings: {
    config
  },
  state,
  threadCache,
  chats: {
    get: getChatState
  },
  sessions: {
    findFile: findCodexSessionFile,
    listRecent: listRecentCodexSessions,
    readMeta: readSessionMeta
  },
  localization: {
    text: t,
    formatText: tf
  },
  formatting: {
    bytes: formatBytes,
    count: cleanupCount,
    keyValue: formatKeyValueHtml,
    localDateKey: getLocalDateKey
  }
});
const {
  autoHandoffEnabled: maintenanceAutoHandoffEnabled,
  autoSqliteRepairEnabled: maintenanceAutoSqliteRepairEnabled,
  createCurrentHandoff: createCurrentThreadHandoff,
  createThreadHandoff,
  formatHandoff: formatHandoffResultHtml,
  formatReport: formatCodexMaintenanceReportHtml,
  formatResult: formatCodexMaintenanceResultHtml,
  menuHtml: codexMaintenanceMenuHtml,
  readReport: readCodexMaintenanceReport,
  run: runCodexMaintenance,
  sqliteRepairConfirmHtml: codexMaintenanceSqliteRepairConfirmHtml
} = maintenanceController;
const {
  createChatExport,
  createStateBackup,
  startStateSnapshotScheduler
} = createBackupController({
  settings: {
    config,
    runtimeValue
  },
  state,
  activeTurns,
  threadCache,
  chats: {
    get: getChatState,
    getEffectiveOptions
  },
  queue: {
    countPending: countPendingTurns,
    pending: getPendingTurns
  },
  app: {
    buildConfigSummary,
    buildSummary: buildAppSummary,
    redactValue
  },
  persistence: {
    save: () => saveState(config.stateFile, state)
  },
  clock: {
    getLocalClock
  }
});

const {
  fastPanelHtml,
  runtimePanelHtml,
  sendPanel,
  settingsPanelHtml
} = createRuntimePanelController({
  settings: {
    config,
    runtimeValue,
    runtimeSeconds
  },
  state,
  threadCache,
  chats: {
    effectiveModelSlug,
    formatOptions: formatOptionsHtml,
    get: getChatState,
    getEffectiveOptions
  },
  queue: {
    countPending: countPendingTurns,
    pruneExpired: pruneExpiredPendingTurns
  },
  status: {
    buildDetails: buildStatusDetails,
    formatQueue: formatQueueHtml,
    formatStatus: formatStatusHtml
  },
  models: {
    formatFastStatus: formatFastStatusHtml,
    formatReasoningPrompt: formatReasoningPromptHtml,
    formatSelection: formatModelSelectionHtml,
    list: listCodexModels,
    reasoningOptions: reasoningOptionsForModel
  },
  keyboards: {
    approval: approvalKeyboard,
    backToMain: backToMainKeyboard,
    booleanOption: booleanOptionKeyboard,
    fast: fastKeyboard,
    language: languageKeyboard,
    liveProgress: liveProgressKeyboard,
    locale: localeKeyboard,
    mainPanel: mainPanelKeyboard,
    modelSelection: modelSelectionKeyboard,
    paths: pathsKeyboard,
    previousPanelFor,
    queue: queueKeyboard,
    reasoningSelection: reasoningSelectionKeyboard,
    runtime: runtimeKeyboard,
    runtimeCleanup: runtimeCleanupKeyboard,
    runtimeCodex: runtimeCodexKeyboard,
    runtimeOutput: runtimeOutputKeyboard,
    runtimeQueue: runtimeQueueKeyboard,
    runtimeSnapshot: runtimeSnapshotKeyboard,
    sandbox: sandboxKeyboard,
    schema: schemaKeyboard,
    settings: settingsKeyboard,
    settingsSelection: settingsSelectionKeyboard,
    status: statusKeyboard,
    timeZone: timeZoneKeyboard,
    timeZoneGroup: timeZoneGroupKeyboard,
    tools: toolsKeyboard,
    webSearch: webSearchKeyboard,
    withClose: withMenuCloseButton,
    withPrevious: withPreviousPanelButton
  },
  views: {
    renderFast: renderFastPanelHtml,
    renderLiveProgress: renderLiveProgressPanelHtml,
    renderMain: renderMainPanelHtml,
    renderPaths: renderPathsPanelHtml,
    renderRuntime: renderRuntimePanelHtml,
    renderSchema: renderSchemaPanelHtml,
    renderSetting: renderSettingPanelHtml,
    renderSettings: renderSettingsPanelHtml,
    renderTimeZoneGroup: renderTimeZoneGroupPanelHtml,
    renderTools: renderToolsPanelHtml
  },
  telegram: {
    editOrReplyHtml,
    getChatKey,
    replyHtml
  },
  localization: {
    language: uiLanguage,
    locale: uiLocale,
    text: t,
    timeZone: uiTimeZone
  },
  formatting: {
    duration: formatDurationSeconds,
    keyValue: formatKeyValueHtml,
    optional: formatOptional
  },
  help: {
    html: helpTextHtml
  }
});
const {
  handleAppServerStatusButton,
  handleQueueButton,
  handleSettingButton,
  handleWorkerStatusButton
} = createSettingsCallbackController({
  settings: {
    config,
    runtimeValue,
    updateRuntimeSetting,
    validQueueModes: VALID.queueMode,
    saveState: () => saveState(config.stateFile, state)
  },
  state,
  chats: {
    get: getChatState,
    invalidateThreadCache,
    setOption
  },
  queue: {
    format: formatQueueHtml,
    pruneExpired: pruneExpiredPendingTurns,
    setMode: setQueueMode,
    setPaused: setQueuePaused,
    startDrain: startQueueDrainIfIdle
  },
  panels: {
    runtimeHtml: runtimePanelHtml,
    settingsHtml: settingsPanelHtml
  },
  keyboards: {
    inline: inlineKeyboard,
    queue: queueKeyboard,
    runtime: runtimeKeyboard,
    runtimeCodex: runtimeCodexKeyboard,
    settings: settingsKeyboard,
    withClose: withMenuCloseButton
  },
  telegram: {
    editOrReplyHtml,
    getChatKey,
    rejectCallbackIfActive,
    summarizeError: summarizeTelegramError
  },
  localization: {
    text: t
  },
  preferences: {
    locales: LOCALE_CHOICES,
    parseLanguage,
    parseLocale,
    parseTimeZone,
    timeZones: TIME_ZONE_CHOICES
  },
  diagnostics: {
    appServerDirectArgs,
    readCommandOutput
  },
  worker: {
    getClient: getWorkerClient
  },
  formatting: {
    keyValue: formatKeyValueHtml,
    truncate
  },
  commands: {
    register: registerTelegramCommands
  }
});
const { handleToolButton } = createToolCallbackController({
  settings: {
    config,
    runtimeValue
  },
  state,
  telegram: {
    editOrReplyHtml,
    getChatKey,
    rejectCallbackIfActive,
    replyDocument: replyDocumentQuietly,
    replyHtml
  },
  keyboards: {
    inline: inlineKeyboard,
    maintenance: codexMaintenanceKeyboard,
    maintenanceBusy: codexMaintenanceBusyKeyboard,
    withClose: withMenuCloseButton,
    withToolsBack
  },
  diagnostics: {
    formatConfig: formatConfigHtml,
    formatDoctor: formatDoctorHtml,
    formatHealth: formatHealthHtml,
    formatLogs: formatLogsHtml,
    formatWhoami: formatWhoamiHtml,
    handleAppServerStatus: handleAppServerStatusButton,
    handleWorkerStatus: handleWorkerStatusButton
  },
  skills: {
    replyStatus: replyCodexSkillsStatus
  },
  backup: {
    createChatExport,
    createState: createStateBackup
  },
  cleanup: {
    handleCommand: (...args) => adminCommandHandlers.handleCleanupCommand(...args)
  },
  maintenance: {
    autoHandoffEnabled: maintenanceAutoHandoffEnabled,
    autoSqliteRepairEnabled: maintenanceAutoSqliteRepairEnabled,
    createCurrentHandoff: createCurrentThreadHandoff,
    formatHandoff: formatHandoffResultHtml,
    formatReport: formatCodexMaintenanceReportHtml,
    formatResult: formatCodexMaintenanceResultHtml,
    menuHtml: codexMaintenanceMenuHtml,
    readReport: readCodexMaintenanceReport,
    run: runCodexMaintenance,
    sqliteRepairConfirmHtml: codexMaintenanceSqliteRepairConfirmHtml
  },
  persistence: {
    save: () => saveState(config.stateFile, state)
  },
  formatting: {
    bytes: formatBytes,
    keyValue: formatKeyValueHtml
  },
  localization: {
    text: t
  }
});

const replaceChatOptions = createAtomicChatOptionsReplacer({
  getChat: getChatState,
  save: () => saveState(config.stateFile, state),
  invalidate: (chatKey) => threadCache.delete(chatKey)
});
const {
  handleMenuClose,
  handleSettingsModelSelection,
  handleSettingsReasoningSelection,
  handleStandaloneFastSelection,
  handleStandaloneModelSelection,
  handleStandaloneReasoningSelection,
  handleStandaloneSelectionCancel,
  sendStandaloneModelSelection,
  sendStandaloneReasoningSelection
} = createModelSelectionController({
  flowStore: selectionFlows,
  models: {
    list: listCodexModels,
    defaultSlug: () => config.codexModel ?? "",
    planTransition: planRuntimeModelReasoningTransition
  },
  chat: {
    keyFromContext: getChatKey,
    getOptions: (chatKey) => getChatState(chatKey).options,
    replaceOptions: replaceChatOptions,
    isActive: (chatKey) => activeTurns.has(chatKey),
    rejectIfActive,
    effectiveModelSlug
  },
  telegram: {
    replyHtml,
    editOrReplyHtml,
    editStrict: editSelectionMessageStrict,
    answerUiCallback
  },
  views: {
    emptyInlineKeyboard,
    fastKeyboard,
    fastPanelHtml,
    formatModelSelectionHtml,
    formatReasoningPromptHtml,
    formatStandaloneFastPromptHtml,
    formatStandaloneReasoningPromptHtml,
    formatStandaloneSelectionResultHtml,
    settingsSelectionKeyboard,
    standaloneFastSelectionKeyboard,
    standaloneModelSelectionKeyboard,
    standaloneReasoningSelectionKeyboard
  },
  text: t
});
const {
  answerCleanupCallback,
  answerUploadCleanupCallback,
  appendCleanupLog,
  collectProtectedThreadIds,
  createUploadCleanupPlan,
  editCleanupMessage,
  editCleanupProcessingMessage,
  editUploadCleanupMessage,
  formatCleanupIgnoredHtml,
  formatCleanupResultHtml,
  listCleanupSessionFiles,
  listQuarantineDeleteCandidates,
  pruneExpiredCleanupPlans,
  startCleanupScheduler
} = createCleanupRuntime({
  settings: {
    config,
    runtimeValue
  },
  state,
  activeTurns,
  threadCache,
  sessions: {
    listFiles,
    readMeta: readSessionMeta
  },
  cleanup: {
    sendDailyPlan: (...args) => sendDailyCleanupPlan(...args)
  },
  maintenance: {
    autoHandoffEnabled: maintenanceAutoHandoffEnabled,
    autoSqliteRepairEnabled: maintenanceAutoSqliteRepairEnabled,
    createThreadHandoff,
    run: runCodexMaintenance
  },
  telegram: {
    editOrReplyHtml,
    summarizeError: summarizeTelegramError
  },
  localization: {
    text: t,
    formatText: tf
  },
  formatting: {
    count: cleanupCount,
    localClock: getLocalClock
  },
  persistence: {
    save: () => saveState(config.stateFile, state)
  },
  uploads: {
    buildPlan: buildUploadCleanupPlanFromDisk,
    createPlanLogEntry: createUploadCleanupPlanLogEntry,
    shouldRun: shouldRunUploadCleanup
  }
});
const {
  applyCleanupPlan,
  createCleanupPlan,
  sendCleanupPlan,
  sendDailyCleanupPlan
} = createCleanupController({
  stateStore: {
    plans: state.cleanup.plans,
    prunePlans: pruneExpiredCleanupPlans,
    save: () => saveState(config.stateFile, state),
    appendLog: appendCleanupLog
  },
  policy: {
    planTtlHours: () => runtimeValue("cleanupPlanTtlHours"),
    retentionDays: () => runtimeValue("cleanupRetentionDays"),
    quarantineDays: () => runtimeValue("cleanupQuarantineDays"),
    artifactDir: config.cleanupArtifactDir,
    sessionsDir: config.codexSessionsDir,
    quarantineDir: config.cleanupQuarantineDir,
    notifyChatIds: config.cleanupNotifyChatIds,
    maintenanceLogRotateMb: config.codexMaintenanceLogRotateMb,
    dateKey: getLocalDateKey
  },
  inventory: {
    collectProtectedThreadIds,
    listSessionFiles: listCleanupSessionFiles,
    listDeleteCandidates: listQuarantineDeleteCandidates,
    readMaintenanceReport: readCodexMaintenanceReport
  },
  telegram: {
    replyHtml,
    sendHtmlMessage
  },
  formatting: {
    text: t,
    formatText: tf,
    formatBytes,
    formatDateTime,
    formatCount: cleanupCount
  }
});
const {
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
} = createTurnRecoveryJournal({
  settings: {
    enabled: config.botRestartRecoveryEnabled,
    recoveryDir: config.botRecoveryDir,
    defaultWorkdir: config.codexWorkdir,
    defaultModel: config.codexModel
  },
  state,
  activeTurns,
  threadCache,
  chats: {
    get: getChatState
  },
  options: {
    get: getEffectiveOptions
  },
  persistence: {
    save: () => saveState(config.stateFile, state)
  },
  telegram: {
    replyHtml
  },
  formatting: {
    truncate
  },
  text: t
});
const {
  createLiveProgressState,
  formatTurn,
  maybeSendLiveProgress,
  shouldDeleteLiveProgress,
  summarizeProgress
} = createLiveProgressController({
  settings: {
    runtimeValue
  },
  options: {
    get: getEffectiveOptions,
    defaults: defaultChatOptions
  },
  telegram: {
    getChatKey,
    replyTracked: (...args) => replyTrackedProgressHtml(...args)
  },
  recovery: {
    recordProgressFailed: (...args) => recordTelegramProgressFailed(...args)
  },
  localization: {
    language: uiLanguage,
    forLanguage: lt,
    formatForLanguage: ltf
  },
  formatting: {
    redact: redactText,
    truncate
  }
});
const {
  maybeNotifyContextPressure,
  refreshUsageSample,
  runCodexTurn,
  tryBackfillCompletedStream
} = createCodexRuntimeExecutor({
  settings: {
    recoveryEnabled: config.botRestartRecoveryEnabled,
    runtimeValue,
    codexPath: config.codexPath,
    codexEnv: config.codexEnv,
    sessionsDir: config.codexSessionsDir,
    contextGuardEnabled: config.codexContextGuardEnabled,
    contextCompactThresholdPercent: config.codexContextCompactThresholdPercent,
    contextMinRemainingTokens: config.codexContextMinRemainingTokens,
    config
  },
  chats: {
    get: getChatState,
    save: () => saveState(config.stateFile, state)
  },
  options: {
    build: buildTurnOptions,
    get: getEffectiveOptions
  },
  threads: {
    start: (...args) => startCodexThread(...args),
    transport: (...args) => threadTransport(...args),
    currentTransport: codexTransport
  },
  recovery: {
    appendEvent: (...args) => appendRecoveryEvent(...args),
    recordActiveTurnFailed: (...args) => recordActiveTurnFailed(...args),
    recordBackfill: (...args) => recordCodexStreamBackfill(...args),
    recordFinalResponse: (...args) => recordCodexStreamFinalResponseSeen(...args),
    recordFirstItem: (...args) => recordCodexStreamFirstItem(...args),
    recordIdleNotice: (...args) => recordStreamIdleNotice(...args),
    recordIdleTimeout: (...args) => recordStreamIdleTimeout(...args),
    recordIteratorClosed: (...args) => recordCodexStreamIteratorClosed(...args),
    recordStreamItem: (...args) => recordStreamItemEvent(...args),
    recordStreamStarted: (...args) => recordCodexStreamStarted(...args),
    recordThreadStarted: (...args) => recordThreadStarted(...args),
    recordUnknownEvent: (...args) => recordCodexStreamUnknownEvent(...args)
  },
  progress: {
    editMessage: editMessageQuietly,
    maybeSend: maybeSendLiveProgress,
    summarize: summarizeProgress
  },
  usage: {
    readLatestTokenCount: (...args) => readLatestTokenCount(...args)
  },
  telegram: {
    replyHtml
  },
  formatting: {
    keyValue: formatKeyValueHtml,
    truncate
  },
  text: t,
  sleep
});
let workerClient = null;
const {
  cancelWorkerJobOnce,
  processPreparedTurnViaWorker,
  waitForWorkerJob
} = createWorkerRuntimeController({
  settings: {
    recoveryEnabled: config.botRestartRecoveryEnabled,
    recoveryDir: config.botRecoveryDir,
    eventPollMs: () => runtimeValue("codexWorkerEventPollMs")
  },
  deliveryStore: {
    get: (key) => state.worker?.deliveries?.[key],
    set: (key, value) => {
      if (!state.worker || typeof state.worker !== "object") {
        state.worker = { deliveries: {} };
      }
      if (!state.worker.deliveries || typeof state.worker.deliveries !== "object") {
        state.worker.deliveries = {};
      }
      state.worker.deliveries[key] = value;
    },
    save: () => saveState(config.stateFile, state)
  },
  chatStore: {
    get: getChatState,
    getEffectiveOptions
  },
  worker: {
    getClient: getWorkerClient,
    mode: codexWorkerMode,
    transport: codexTransport
  },
  turn: {
    createQueueItemId,
    maybeNotifyContextPressure,
    maybeSendLiveProgress,
    recordActiveTurnFailed,
    recordCodexStreamFinalResponseSeen,
    recordCodexStreamFirstItem,
    recordCodexStreamIteratorClosed,
    recordCodexStreamStarted,
    recordCodexStreamUnknownEvent,
    recordStreamItemEvent,
    recordThreadStarted
  },
  recovery: {
    appendEvent: appendRecoveryEvent,
    write: safeRecoveryWrite
  },
  sleep
});
let runtimeRecoveryController = null;
const {
  handleCodexMessage,
  runPreparedTurnQueue,
  startPreparedTurnQueue
} = createTurnRuntimeController({
  settings: {
    maxPendingTurns: () => runtimeValue("telegramPendingTurnsMax"),
    pendingTurnMaxAgeSeconds: () => runtimeValue("telegramPendingTurnMaxAgeSeconds"),
    thinkingReaction: config.telegramThinkingReaction,
    stoppedReaction: config.telegramStoppedReaction,
    errorReaction: config.telegramErrorReaction,
    completeReaction: config.telegramCompleteReaction
  },
  activeTurns,
  queue: {
    createItemId: createQueueItemId,
    dequeue: dequeuePendingTurn,
    enqueue: enqueuePendingTurn,
    enqueueFront: enqueuePendingTurnFront,
    getMode: getQueueMode,
    getPending: getPendingTurns,
    hasPendingFinalDelivery,
    isPaused: isQueuePaused,
    pruneExpired: pruneExpiredPendingTurns
  },
  lifecycle: {
    isRecoveryActive,
    isRestartScheduled: () => runtimeRecoveryController?.isRestartScheduled() ?? false
  },
  context: {
    applyPersonaPrompt,
    buildReplyContext,
    ensureTurnContext,
    getChatKey,
    telegramMessageMeta
  },
  codex: {
    formatTurn,
    getChatThreadId: (chatKey) => getChatState(chatKey).threadId,
    getOrCreateThread,
    maybeNotifyContextPressure,
    rememberThread,
    runTurn: runCodexTurn,
    startThread: startCodexThread
  },
  worker: {
    enabled: useWorkerSidecar,
    processPreparedTurn: processPreparedTurnViaWorker
  },
  recovery: {
    recordActiveTurnCompleted,
    recordActiveTurnFailed,
    recordActiveTurnStarted,
    recordTelegramReplyCompleted,
    recordTelegramReplyFailed,
    recordTelegramReplyReady,
    recordTelegramReplyStarted,
    restoreThreadForTurn: restoreRecoveryThreadForTurn
  },
  progress: {
    createState: createLiveProgressState,
    deleteMessages: deleteTrackedProgressMessages,
    shouldDelete: shouldDeleteLiveProgress
  },
  telegram: {
    reactQuietly,
    replyCodexAnswer,
    replyHtml
  },
  status: {
    buildStatusDetails,
    formatStatusHtml,
    isStatusQuestion
  },
  sideTurns: {
    track: trackSideTurn,
    untrack: untrackSideTurn
  },
  text: t
});
runtimeRecoveryController = createRuntimeRecoveryController({
  settings: {
    enabled: config.botRestartRecoveryEnabled,
    recoveryDir: config.botRecoveryDir,
    recoveryStaleSeconds: config.botRecoveryStaleSeconds,
    recoverySuspendAfter: config.botRecoverySuspendAfter,
    recoveryTurnTtlSeconds: config.botRecoveryTurnTtlSeconds,
    workingDirectory: config.codexWorkdir,
    restartExitCode: config.botRestartExitCode,
    restartDrainTimeoutSeconds: config.botRestartDrainTimeoutSeconds,
    restartDelaySeconds: config.botRestartDelaySeconds,
    stoppedReaction: config.telegramStoppedReaction,
    errorReaction: config.telegramErrorReaction,
    completeReaction: config.telegramCompleteReaction
  },
  stateStore: {
    activeTurns,
    getWorkerDeliveries: () => state.worker?.deliveries ?? {},
    replaceWorkerDeliveries: (deliveries) => {
      state.worker.deliveries = deliveries;
    },
    getChat: getChatState,
    save: () => saveState(config.stateFile, state)
  },
  queue: {
    enqueueFrontForced: async (chatKey, preparedTurn) => {
      pendingTurns.set(chatKey, [preparedTurn, ...getPendingTurns(chatKey)]);
      await persistPendingTurns(chatKey);
    },
    dequeue: dequeuePendingTurn,
    startPrepared: startPreparedTurnQueue,
    startDrain: startQueueDrainIfIdle
  },
  worker: {
    enabled: useWorkerSidecar,
    getClient: getWorkerClient,
    waitForJob: waitForWorkerJob,
    transport: codexTransport
  },
  turn: {
    appendRecoveryEvent,
    createCodexThread,
    createLiveProgressState,
    createSyntheticCtx,
    deleteTrackedProgressMessages,
    digestText,
    formatTurn,
    markActiveTurnStopped,
    recordActiveTurnCompleted,
    recordActiveTurnFailed,
    recordTelegramReplyCompleted,
    recordTelegramReplyDigestMismatch,
    recordTelegramReplyFailed,
    recordTelegramReplyReady,
    recordTelegramReplyStarted,
    shouldDeleteLiveProgress,
    tryBackfillCompletedStream
  },
  telegram: {
    notifyExtra: telegramNotifyExtra,
    reactQuietly,
    replyCodexAnswer,
    replyHtml,
    sendHtmlMessage
  },
  formatting: {
    restartRecovered: formatRestartRecoveredHtml,
    restartScheduled: formatRestartScheduledHtml
  },
  lifecycle: {
    stopBot: (signalName) => bot.stop(signalName),
    exit: (codeValue) => process.exit(codeValue)
  },
  text: t,
  sleep
});
const {
  handleProcessSignal,
  handleRestartCommand,
  scheduleStartupRecovery,
  startRecoveryScheduler
} = runtimeRecoveryController;

hydratePendingTurnsFromState();

registerTelegramMiddleware({
  bot,
  config,
  authorize: authorizeTelegramUpdate,
  telegram: {
    replyHtml,
    summarizeError: summarizeTelegramError
  }
});

chatCommandHandlers = registerChatCommands({
  bot,
  settings: {
    config,
    validApprovalPolicies: VALID.approval,
    validSandboxModes: VALID.sandbox,
    validWebSearchModes: VALID.webSearch
  },
  activeTurns,
  threadCache,
  chats: {
    get: getChatState,
    getEffectiveOptions,
    invalidateThreadCache,
    rejectIfActive
  },
  threads: {
    remember: rememberThread,
    resume: resumeCodexThread,
    start: startCodexThread
  },
  sessions: {
    listRecent: listRecentCodexSessions
  },
  turns: {
    applyPersonaPrompt,
    run: runCodexTurn
  },
  models: {
    formatFastStatus: formatFastStatusHtml,
    list: listCodexModels,
    sendStandaloneModelSelection,
    sendStandaloneReasoningSelection
  },
  options: {
    format: formatOptionsHtml,
    updateCommand: updateOptionCommand,
    updateValue: updateOptionValue
  },
  panels: {
    helpHtml: helpTextHtml,
    send: sendPanel
  },
  status: {
    buildDetails: buildStatusDetails,
    format: formatStatusHtml,
    keyboard: statusKeyboard
  },
  queue: {
    pruneExpired: pruneExpiredPendingTurns
  },
  telegram: {
    getChatKey,
    getCommandArgs,
    reactQuietly,
    replyHtml
  },
  localization: {
    text: t
  },
  formatting: {
    keyValue: formatKeyValueHtml,
    unique
  },
  filesystem: {
    ensureDirectory
  },
  persistence: {
    save: () => saveState(config.stateFile, state)
  }
});
adminCommandHandlers = registerAdminCommands({
  bot,
  settings: {
    config,
    runtimeValue,
    validQueueModes: VALID.queueMode
  },
  state,
  activeTurns,
  threadCache,
  pendingTurns,
  chats: {
    get: getChatState,
    invalidateThreadCache,
    rejectIfActive
  },
  panels: {
    send: sendPanel
  },
  diagnostics: {
    formatConfig: formatConfigHtml,
    formatDoctor: formatDoctorHtml,
    formatHealth: formatHealthHtml,
    formatLogs: formatLogsHtml,
    formatWhoami: formatWhoamiHtml
  },
  skills: {
    replyStatus: replyCodexSkillsStatus
  },
  backup: {
    createChatExport,
    createState: createStateBackup
  },
  recovery: {
    cancelWorkerJobOnce,
    clearCompleted: clearCompletedRecovery,
    clearPendingTurns: clearRecoveryPendingTurns,
    formatStatus: formatRecoveryStatusHtml,
    handleRestartCommand,
    markActiveTurnStopped,
    scheduleStartup: scheduleStartupRecovery
  },
  queue: {
    clearPending: clearPendingTurns,
    format: formatQueueHtml,
    formatMode: formatQueueModeHtml,
    keyboard: queueKeyboard,
    pruneExpired: pruneExpiredPendingTurns,
    removePending: removePendingTurn,
    setMode: setQueueMode,
    setPaused: setQueuePaused,
    startDrain: startQueueDrainIfIdle,
    stopSideTurns
  },
  cleanup: {
    appendLog: appendCleanupLog,
    createPlan: createCleanupPlan,
    createUploadPlan: createUploadCleanupPlan,
    createUploadPlanLogEntry: createUploadCleanupPlanLogEntry,
    createUploadPlanRecord: createUploadCleanupPlanRecord,
    formatUploadPlan: formatUploadCleanupPlanHtml,
    sendPlan: sendCleanupPlan,
    uploadKeyboard: uploadCleanupKeyboard
  },
  telegram: {
    editOrReplyHtml,
    getChatKey,
    getCommandArgs,
    replyDocument: replyDocumentQuietly,
    replyHtml
  },
  localization: {
    text: t
  },
  formatting: {
    bytes: formatBytes,
    formatPrefs: formatPrefsHtml,
    keyValue: formatKeyValueHtml
  },
  persistence: {
    save: () => saveState(config.stateFile, state)
  }
});
registerCallbackRoutes({
  bot,
  settings: {
    config,
    runtimeValue
  },
  state,
  threadCache,
  pendingTurns,
  usageRefreshes,
  cleanup: {
    answerCallback: answerCleanupCallback,
    answerUploadCallback: answerUploadCleanupCallback,
    appendLog: appendCleanupLog,
    applyPlan: applyCleanupPlan,
    confirmUploadPlan: confirmUploadCleanupPlan,
    createUploadResultLogEntry: createUploadCleanupResultLogEntry,
    deleteUploadCandidates,
    editMessage: editCleanupMessage,
    editProcessingMessage: editCleanupProcessingMessage,
    editUploadMessage: editUploadCleanupMessage,
    formatDateTime,
    formatIgnored: formatCleanupIgnoredHtml,
    formatResult: formatCleanupResultHtml,
    formatUploadProcessing: formatUploadCleanupProcessingHtml,
    formatUploadResult: formatUploadCleanupResultHtml
  },
  queue: {
    clear: clearPendingTurns,
    format: formatQueueHtml,
    keyboard: queueKeyboard,
    move: movePendingTurn,
    pruneExpired: pruneExpiredPendingTurns,
    remove: removePendingTurn,
    sideTurnCount: getSideTurnCount
  },
  selection: {
    handleMenuClose,
    handleSettingsModel: handleSettingsModelSelection,
    handleSettingsReasoning: handleSettingsReasoningSelection,
    handleStandaloneCancel: handleStandaloneSelectionCancel,
    handleStandaloneFast: handleStandaloneFastSelection,
    handleStandaloneModel: handleStandaloneModelSelection,
    handleStandaloneReasoning: handleStandaloneReasoningSelection
  },
  panels: {
    send: sendPanel,
    settingsHtml: settingsPanelHtml
  },
  callbacks: {
    handleQueue: handleQueueButton,
    handleSetting: handleSettingButton,
    handleTool: handleToolButton
  },
  skills: {
    isView: isCodexSkillsView,
    replyStatus: replyCodexSkillsStatus
  },
  commands: {
    handleNew: chatCommandHandlers.handleNewCommand,
    handleRestart: handleRestartCommand,
    handleResume: chatCommandHandlers.handleResumeCommand,
    handleStop: adminCommandHandlers.handleStopCommand
  },
  chats: {
    get: getChatState,
    invalidateThreadCache,
    rejectCallbackIfActive
  },
  usage: {
    refreshSample: refreshUsageSample
  },
  status: {
    buildDetails: buildStatusDetails,
    format: formatStatusHtml,
    keyboard: statusKeyboard
  },
  telegram: {
    editOrReplyHtml,
    getChatKey,
    replyHtml,
    summarizeError: summarizeTelegramError
  },
  keyboards: {
    backToMain: backToMainKeyboard,
    inline: inlineKeyboard,
    settings: settingsKeyboard,
    withClose: withMenuCloseButton,
    withToolsBack
  },
  localization: {
    text: t
  },
  persistence: {
    save: () => saveState(config.stateFile, state)
  },
  timing: {
    withTimeout
  }
});
registerTelegramMessageRoutes({
  bot,
  input: {
    downloadFile: downloadTelegramFile,
    downloadPdf: downloadTelegramPdf,
    extensionFromMime,
    formatUploadedPdf: formatUploadedPdfUploadHtml,
    getChatKey,
    getFreshLastPdf: getFreshLastPdfUpload,
    handleCodexMessage,
    rememberLastPdfUpload
  },
  pdf: {
    mergeReferences: mergePdfReferences,
    planInput: planTelegramDocumentInput,
    shouldUseRecent: shouldUseRecentPdfUpload
  },
  telegram: {
    replyHtml
  },
  localization: {
    text: t
  },
  commands: {
    isRegistered: isRegisteredTelegramCommandText
  }
});
await bootstrapBot({
  bot,
  config,
  ensureDirectory,
  registerTelegramCommands,
  startCleanupScheduler,
  startPersistedQueues,
  startStateSnapshotScheduler,
  startRecoveryScheduler,
  handleSignal: handleProcessSignal
});

function codexTransport() {
  return runtimeValue("codexTransport");
}

function codexWorkerMode() {
  return runtimeValue("codexWorkerMode");
}

function useWorkerSidecar() {
  return codexWorkerMode() === "sidecar";
}

function getWorkerClient() {
  if (!workerClient) workerClient = createWorkerClient(config);
  return workerClient;
}

function startCodexThread(chatKey) {
  return createCodexThread(chatKey, "");
}

function resumeCodexThread(chatKey, threadId) {
  return createCodexThread(chatKey, threadId);
}

function createCodexThread(chatKey, threadId = "") {
  return createCodexThreadForTransport({
    transport: codexTransport(),
    threadId,
    effectiveOptions: getEffectiveOptions(chatKey),
    config: {
      ...config,
      codexAppServerDirectTimeoutMs: runtimeValue("codexAppServerDirectTimeoutMs")
    },
    codexClients
  });
}

function threadTransport(thread) {
  return detectThreadTransport(thread);
}

function getOrCreateThread(chatKey) {
  const cached = threadCache.get(chatKey);
  if (cached && threadTransport(cached) === codexTransport()) return cached;
  if (cached) threadCache.delete(chatKey);

  const savedThreadId = getChatState(chatKey).threadId;
  const thread = savedThreadId ? resumeCodexThread(chatKey, savedThreadId) : startCodexThread(chatKey);
  threadCache.set(chatKey, thread);
  return thread;
}

async function rememberThread(chatKey, thread) {
  if (!thread.id) return;
  const chat = getChatState(chatKey);
  chat.threadId = thread.id;
  chat.updatedAt = new Date().toISOString();
  await saveState(config.stateFile, state);
}

async function rejectIfActive(ctx, chatKey) {
  if (!activeTurns.has(chatKey)) return false;
  await replyHtml(ctx, `Codex turn is already running. Use ${code("/stop")} first. Plain messages can still be queued.`);
  return true;
}

function isStatusQuestion(text) {
  const normalized = String(text || "").trim().toLowerCase();
  if (normalized.length > 80) return false;
  return [
    "status",
    "progress",
    "queue",
    "뭐해",
    "뭐 하는",
    "뭐하고",
    "진행",
    "상태",
    "멈췄",
    "멈춘",
    "어디까지",
    "작업 중",
    "작업중",
    "하고 있어",
    "진행중"
  ].some((keyword) => normalized.includes(keyword));
}

async function ensureDirectory(dir, label) {
  const stat = await fs.stat(dir);
  if (!stat.isDirectory()) throw new Error(`${label} is not a directory: ${dir}`);
}

async function listRecentCodexSessions(limit) {
  let files = [];
  try {
    files = await listFiles(config.codexSessionsDir);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  const sessions = [];
  for (const file of files.filter((entry) => entry.endsWith(".jsonl")).sort().reverse()) {
    const meta = await readSessionMeta(file);
    if (meta) sessions.push(meta);
    if (sessions.length >= Math.max(limit, 20)) break;
  }

  return sessions
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
    .slice(0, limit);
}

async function listFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(fullPath));
    else if (entry.isFile()) files.push(fullPath);
  }
  return files;
}

async function readSessionMeta(file) {
  try {
    const firstLine = await readFirstLine(file);
    const parsed = JSON.parse(firstLine);
    if (parsed?.type !== "session_meta" || !parsed.payload?.id) return null;
    return {
      id: parsed.payload.id,
      timestamp: parsed.payload.timestamp ?? parsed.timestamp ?? "",
      cwd: parsed.payload.cwd ?? "unknown",
      source: parsed.payload.source ?? "unknown",
      originator: parsed.payload.originator ?? "unknown",
      path: file
    };
  } catch {
    return null;
  }
}

async function findCodexSessionFile(threadId) {
  if (!threadId) return null;
  let files = [];
  try {
    files = await listFiles(config.codexSessionsDir);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }

  for (const file of files.filter((entry) => entry.endsWith(".jsonl")).sort().reverse()) {
    const meta = await readSessionMeta(file);
    if (meta?.id === threadId) return file;
  }
  return null;
}

function readFirstLine(file) {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(file, { encoding: "utf8" });
    let buffer = "";
    let settled = false;
    stream.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex !== -1) {
        settled = true;
        resolve(buffer.slice(0, newlineIndex));
        stream.destroy();
      }
    });
    stream.on("error", reject);
    stream.on("close", () => {
      if (!settled) resolve(buffer);
    });
  });
}

function formatConfigHtml() {
  return formatKeyValueHtml("Codex runtime config:", [
    ["worker mode", runtimeValue("codexWorkerMode")],
    ["worker socket", config.codexWorkerSocket],
    ["worker event poll", `${runtimeValue("codexWorkerEventPollMs")}ms`],
    ["transport", runtimeValue("codexTransport")],
    ["codexPathOverride", config.codexPath],
    ["app-server direct timeout", `${runtimeValue("codexAppServerDirectTimeoutMs")}ms`],
    ["baseUrl", config.codexBaseUrl || "default"],
    ["apiKey", config.codexApiKey ? "set" : "default auth"],
    ["config", config.codexConfig ? "set" : "none"],
    ["auto compact token limit", resolveAutoCompactTokenLimit(config) || "default"],
    ["compact strength", config.codexCompactStrength],
    ["context guard", config.codexContextGuardEnabled ? `${config.codexContextCompactThresholdPercent}% / min ${config.codexContextMinRemainingTokens} tokens` : "off"],
    ["restart recovery", config.botRestartRecoveryEnabled ? `on, delay ${config.botRestartDelaySeconds}s, drain ${config.botRestartDrainTimeoutSeconds}s` : "off"],
    ["recovery backfill poll", config.botRecoveryBackfillPollMs > 0 ? `${config.botRecoveryBackfillPollMs}ms` : "off"],
    ["recovery dir", config.botRecoveryDir],
    ["env", config.codexEnv ? "set" : "inherit process.env"],
    ["modelsCacheFile", config.codexModelsCacheFile]
  ]);
}

async function rejectCallbackIfActive(ctx, chatKey) {
  if (!activeTurns.has(chatKey)) return false;
  await editOrReplyHtml(ctx, `Codex turn is already running. Use ${code("/stop")} first. Plain messages can still be queued.`, statusKeyboard(chatKey));
  return true;
}

async function listCodexModels() {
  return readCodexModelCatalog(config.codexModelsCacheFile);
}

function formatReasoningPromptHtml(chatKey, models) {
  const chatOptions = state.chats[chatKey]?.options ?? {};
  const model = effectiveModelSlug(chatKey);
  const reasoning = chatOptions.modelReasoningEffort ?? config.codexReasoningEffort;
  const catalogModel = findCodexModel(models, model);
  const supported = reasoningOptionsForModel(models, model).map(({ effort }) => effort);
  const lines = [
    b(t("thinkingSettingsTitle")),
    `Model: ${code(model || "default")}`,
    `Current thinking: ${code(reasoning)}`
  ];
  if (catalogModel) lines.push(`Catalog default: ${code(catalogModel.defaultReasoning || "unknown")}`);
  lines.push(
    `Supported thinking: ${code(supported.length > 0 ? supported.join(", ") : "none")}`,
    "",
    t("thinkingSettingsDescription")
  );
  return lines.join("\n");
}

function formatStandaloneReasoningPromptHtml(session, models) {
  const catalogModel = findCodexModel(models, session.modelSlug);
  const supported = reasoningOptionsForModel(models, session.modelSlug).map(({ effort }) => effort);
  const lines = [
    b(t("thinkingSettingsTitle")),
    `${t("selectedModelLabel")}: ${code(session.modelSlug || "default")}`,
    `${t("selectedThinkingLabel")}: ${code(session.reasoningChoice || t("notSelected"))}`
  ];
  if (catalogModel) lines.push(`${t("catalogDefaultLabel")}: ${code(catalogModel.defaultReasoning || "unknown")}`);
  lines.push(
    `${t("supportedThinkingLabel")}: ${code(supported.length > 0 ? supported.join(", ") : "none")}`,
    "",
    t("thinkingSettingsDescription")
  );
  return lines.join("\n");
}

function formatStandaloneFastPromptHtml(chatKey, session) {
  const currentTier = getEffectiveOptions(chatKey).serviceTier ?? "default";
  return [
    b(t("fastSelectionTitle")),
    `${t("selectedModelLabel")}: ${code(session.modelSlug || "default")}`,
    `${t("selectedThinkingLabel")}: ${code(session.reasoningChoice || "default")}`,
    `${t("currentFastLabel")}: ${code(currentTier === "fast" ? t("on") : t("off"))}`,
    "",
    t("fastSelectionDescription")
  ].join("\n");
}

function formatStandaloneSelectionResultHtml(chatKey, includeFast = false) {
  const options = getEffectiveOptions(chatKey);
  const lines = [
    `${t("selectedModelLabel")}: ${code(options.model || "default")}`,
    `${t("selectedThinkingLabel")}: ${code(options.modelReasoningEffort)}`
  ];
  if (includeFast) {
    const fast = options.serviceTier === "fast" ? t("on") : options.serviceTier || t("off");
    lines.push(`${t("currentFastLabel")}: ${code(fast)}`);
  }
  return lines.join("\n");
}

function formatFastStatusHtml(chatKey, models) {
  const options = getEffectiveOptions(chatKey);
  const fastModels = models.filter((model) => model.fastSupported).map((model) => model.slug);
  return formatKeyValueHtml("Fast service tier:", [
    ["fast", options.serviceTier === "fast" ? "on" : "off"],
    ["service_tier", options.serviceTier || "default"],
    ["current model", options.model || "default"],
    ["fast-supported models", fastModels.length > 0 ? fastModels.join(", ") : "unknown"]
  ]);
}

function formatOptionsHtml(chatKey) {
  const options = getEffectiveOptions(chatKey);
  return formatKeyValueHtml("Options:", [
    ["model", options.model || "default"],
    ["workingDirectory", options.workingDirectory],
    ["sandboxMode", options.sandboxMode],
    ["approvalPolicy", options.approvalPolicy],
    ["skipGitRepoCheck", options.skipGitRepoCheck],
    ["modelReasoningEffort", options.modelReasoningEffort],
    ["serviceTier", options.serviceTier || "default"],
    ["webSearchMode", options.webSearchMode],
    ["networkAccessEnabled", formatOptional(options.networkAccessEnabled)],
    ["additionalDirectories", (options.additionalDirectories ?? []).join(", ") || "none"],
    ["streamEvents", options.streamEvents],
    ["liveProgressEnabled", options.liveProgressEnabled],
    ["liveProgressSource", options.liveProgressSource],
    ["liveProgressDeletePolicy", options.liveProgressDeletePolicy],
    ["language", uiLanguage()],
    ["timeZone", uiTimeZone()],
    ["locale", uiLocale()],
    ["outputSchema", getChatState(chatKey).outputSchema ? "enabled" : "disabled"]
  ]);
}

function formatUploadCleanupPlanHtml(plan, record = null) {
  const lines = [
    b("Upload cleanup plan"),
    `mode: ${code(plan.dryRun ? "dry-run" : "confirm")}`,
    `upload dir: ${code(config.uploadDir)}`,
    `retention: ${code(`${plan.retentionDays}d`)}`,
    `max bytes: ${code(plan.maxBytes > 0 ? formatBytes(plan.maxBytes) : "off")}`,
    `total uploads: ${code(`${cleanupCount(plan.candidates.length + plan.preserved.length)} / ${formatBytes(plan.totalBytes)}`)}`,
    `cleanup candidates: ${code(`${cleanupCount(plan.candidates.length)} / ${formatBytes(plan.candidateBytes)}`)}`
  ];
  if (record) {
    lines.push(`plan id: ${code(record.id)}`);
    lines.push(`expires: ${code(formatDateTime(record.expiresAt))}`);
  }
  lines.push(`No files are deleted until the ${code("Confirm upload cleanup")} button is pressed.`);
  for (const candidate of plan.candidates.slice(0, 8)) {
    lines.push(`- ${code(path.basename(candidate.path))}: ${code(formatBytes(candidate.bytes ?? 0))}`);
  }
  return lines.join("\n");
}

function formatUploadCleanupProcessingHtml(record) {
  return [
    b("Upload cleanup processing"),
    `plan id: ${code(record.id)}`,
    `candidates: ${code(record.plan.candidates.length)}`
  ].join("\n");
}

function formatUploadCleanupResultHtml(plan, result) {
  return formatKeyValueHtml("Upload cleanup complete", [
    ["candidates", plan.candidates.length],
    ["candidate bytes", formatBytes(plan.candidateBytes)],
    ["deleted", result.deleted],
    ["skipped", result.skipped],
    ["errors", result.errors.length]
  ]);
}

function formatPrefsHtml(chatKey) {
  const chat = getChatState(chatKey);
  const options = getEffectiveOptions(chatKey);
  return formatKeyValueHtml("Chat preferences:", [
    ["thread", chat.threadId || threadCache.get(chatKey)?.id || "not started"],
    ["model", options.model || "default"],
    ["thinking", options.modelReasoningEffort],
    ["fast", options.serviceTier === "fast" ? "on" : "off"],
    ["queue mode", getQueueMode(chatKey)],
    ["workdir", options.workingDirectory],
    ["sandbox", options.sandboxMode],
    ["approval", options.approvalPolicy],
    ["websearch", options.webSearchMode],
    ["network", formatOptional(options.networkAccessEnabled)],
    ["stream", options.streamEvents],
    ["live progress", options.liveProgressEnabled ? `${options.liveProgressSource}, ${options.liveProgressDeletePolicy}` : "off"],
    ["schema", chat.outputSchema ? "enabled" : "disabled"],
    ["additional dirs", (options.additionalDirectories ?? []).join(", ") || "none"],
    ["reset", "/prefs_reset"]
  ]);
}

function formatWhoamiHtml(ctx) {
  const userId = String(ctx.from?.id ?? "");
  return formatKeyValueHtml("Telegram identity:", [
    ["allowed", config.allowedUserIds.has(userId) ? "yes" : "no"],
    ["user id", userId || "unknown"],
    ["chat id", String(ctx.chat?.id ?? "unknown")],
    ["chat type", ctx.chat?.type || "unknown"],
    ["username", ctx.from?.username ? `@${ctx.from.username}` : "none"],
    ["name", [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(" ") || "unknown"],
    ["language", ctx.from?.language_code || "unknown"]
  ]);
}

async function formatLogsHtml(ctx, overrideArg = null) {
  const arg = (overrideArg ?? getCommandArgs(ctx).trim()).toLowerCase();
  let lines = 40;
  let priorityArgs = [];
  if (arg === "error" || arg === "errors") {
    priorityArgs = ["-p", "warning"];
  } else if (arg) {
    const parsed = Number(arg);
    if (!Number.isInteger(parsed) || parsed < 1) {
      return `Usage: ${code("/logs [lines]")} or ${code("/logs_error")}`;
    }
    lines = Math.min(parsed, runtimeValue("logsMaxLines"));
  }
  const result = await readCommandOutput(
    "journalctl",
    ["--user", "-u", "codex-telegram-bot.service", ...priorityArgs, "-n", String(lines), "--no-pager"],
    5000
  );
  if (!result.ok) return `${b("Logs unavailable")}\n${code(result.error)}`;
  let body = redactText(result.output).split("\n").slice(-runtimeValue("logsMaxLines")).join("\n");
  const maxBodyLength = Math.max(500, runtimeValue("maxTelegramChars") - 300);
  if (body.length > maxBodyLength) body = `... truncated ...\n${body.slice(-maxBodyLength)}`;
  return `${b("Recent bot logs:")}\n${pre(body || "no logs")}`;
}

async function registerTelegramCommands() {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const commands = telegramCommands(uiLanguage());
      await withTimeout(Promise.all([
        bot.telegram.setMyCommands(commands),
        ...TELEGRAM_LANGUAGE_CODES.map((languageCode) => bot.telegram.setMyCommands(commands, { language_code: languageCode }))
      ]), 5000, "setMyCommands timed out");
      if (attempt > 1) console.log(`Telegram command menu registered after retry (${attempt}/3).`);
      return;
    } catch (error) {
      console.warn(`Telegram command menu registration failed (${attempt}/3):`, summarizeTelegramError(error));
      if (attempt < 3) await sleep(attempt * 1500);
    }
  }
}

function telegramCommands(language = uiLanguage()) {
  const text = (key) => textFor(language, key);
  return [
    { command: "menu", description: text("commandMenu") },
    { command: "new", description: text("commandNew") },
    { command: "resume", description: text("commandResume") },
    { command: "status", description: text("commandStatus") },
    { command: "queue", description: text("commandQueue") },
    { command: "settings", description: text("commandSettings") },
    { command: "tools", description: text("commandTools") },
    { command: "skills", description: text("commandSkills") },
    { command: "stop", description: text("commandStop") },
    { command: "help", description: text("commandHelp") }
  ];
}

async function replyLong(ctx, text) {
  const max = Math.max(500, runtimeValue("maxTelegramChars"));
  for (const chunk of splitText(text, max)) await ctx.reply(chunk);
}

async function replyCodexAnswer(ctx, text) {
  await replyFormattedCodexAnswer(ctx, text, {
    format: runtimeValue("telegramFormatCodexAnswers"),
    maxTelegramChars: runtimeValue("maxTelegramChars"),
    replyHtml,
    replyLong
  });
}

async function replyHtml(ctx, html, extra = {}) {
  return replyTelegramHtml(ctx, html, extra, { logger: console });
}

async function editOrReplyHtml(ctx, html, extra = {}) {
  return editOrReplyTelegramHtml(ctx, html, extra, { logger: console });
}

async function editSelectionMessageStrict(ctx, html, extra) {
  try {
    await editOrReplyTelegramHtml(ctx, html, extra, {
      logger: console,
      replyOnUnavailable: false
    });
    return true;
  } catch (error) {
    console.warn("Telegram selection message edit failed:", summarizeTelegramError(error));
    return false;
  }
}

async function answerUiCallback(ctx, edited) {
  try {
    if (edited) await ctx.answerCbQuery();
    else await ctx.answerCbQuery(t("selectionUpdateFailed"), { show_alert: true });
  } catch (error) {
    console.warn("Telegram UI callback answer failed:", summarizeTelegramError(error));
  }
}

async function replyTrackedProgressHtml(ctx, progressState, html) {
  const message = await replyHtml(ctx, html);
  trackProgressMessage(ctx, progressState, message);
  return message;
}

function trackProgressMessage(ctx, progressState, message) {
  const chatId = message?.chat?.id ?? ctx.chat?.id;
  const messageId = message?.message_id;
  if (!chatId || !messageId) return;
  progressState.messageRefs.push({ chatId, messageId });
}

async function deleteTrackedProgressMessages(ctx, progressState) {
  const refs = progressState?.messageRefs ?? [];
  progressState.messageRefs = [];
  for (const ref of refs) {
    await ctx.telegram.deleteMessage(ref.chatId, ref.messageId).catch(() => {});
  }
}

async function replyDocumentQuietly(ctx, filePath, caption) {
  try {
    await ctx.replyWithDocument({ source: filePath, filename: path.basename(filePath) }, { caption });
  } catch (error) {
    await replyHtml(ctx, `Document upload failed. File remains on disk:\n${code(filePath)}\n${code(summarizeTelegramError(error).description)}`);
  }
}

async function sendHtmlMessage(chatId, html, extra = {}) {
  return sendTelegramHtml(bot.telegram, chatId, html, extra, { logger: console });
}

function helpTextHtml() {
  return [
    b("Codex Telegram Bot"),
    "",
    b(t("commandsCore")),
    code("/menu"),
    code("/new"),
    code("/resume [thread-id|last]"),
    code("/status"),
    code("/queue"),
    code("/settings"),
    code("/tools"),
    code("/skills"),
    code("/stop"),
    code("/help"),
    "",
    b(t("buttonPanels")),
    `${code("/menu")}: ${t("menuHelp")}`,
    `${code("/settings")}: ${t("settingsHelp")}`,
    `${code("/tools")}: ${t("toolsHelp")}`,
    `${code("/queue")}: ${t("queueHelp")}`,
    "",
    b(t("advancedCommands")),
    code("/threads"),
    code("/queue_pause /queue_resume /queue_mode_safe"),
    code("/model /reasoning /sandbox /approval"),
    code("/workdir /adddir /schema"),
    code("/logs /doctor /backup /export /cleanup"),
    "",
    "Inputs: text, Telegram photo, or image document."
  ].join("\n");
}

async function reactQuietly(ctx, emoji, isBig = false) {
  if (!runtimeValue("telegramReactionsEnabled") || !emoji || !ctx.message) return;
  try {
    await ctx.react(emoji, isBig);
  } catch (error) {
    console.warn("Telegram reaction failed:", summarizeTelegramError(error));
  }
}

async function editMessageQuietly(ctx, messageId, text) {
  try {
    await ctx.telegram.editMessageText(ctx.chat.id, messageId, undefined, text);
  } catch {
    // Progress edits are best-effort.
  }
}

function parseLanguage(value) {
  const normalized = String(value || "en").trim().toLowerCase();
  return VALID.language.has(normalized) ? normalized : "en";
}

function parseTimeZone(value) {
  const normalized = String(value || "UTC").trim() || "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: normalized }).format(new Date());
    return normalized;
  } catch {
    return "UTC";
  }
}

function parseLocale(value) {
  const normalized = String(value || "en-US").trim() || "en-US";
  try {
    return Intl.getCanonicalLocales(normalized)[0] || "en-US";
  } catch {
    return "en-US";
  }
}

function uiLanguage() {
  return parseLanguage(state.ui?.language || config.telegramLanguage);
}

function uiTimeZone() {
  return parseTimeZone(state.ui?.timeZone || config.telegramTimeZone);
}

function uiLocale() {
  return parseLocale(state.ui?.locale || config.telegramLocale);
}

function t(key) {
  return textFor(uiLanguage(), key);
}

function tf(key, values = {}) {
  return t(key).replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name) => (
    Object.hasOwn(values, name) ? String(values[name]) : match
  ));
}

function lt(language, key) {
  return textFor(parseLanguage(language), key);
}

function ltf(language, key, values = {}) {
  return lt(language, key).replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name) => (
    Object.hasOwn(values, name) ? String(values[name]) : match
  ));
}

function cleanupCount(value) {
  return `${value}${t("cleanupCountSuffix")}`;
}

function unique(values) {
  return [...new Set(values)];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, message) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

function formatOptional(value) {
  return typeof value === "boolean" ? String(value) : "default";
}

function truncate(value, max) {
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

function redactValue(value) {
  return JSON.parse(redactText(JSON.stringify(value)));
}

function redactText(value) {
  let text = String(value);
  const token = config.telegramBotToken;
  if (token) text = text.replaceAll(token, "[REDACTED_TELEGRAM_TOKEN]");
  if (config.codexApiKey) text = text.replaceAll(config.codexApiKey, "[REDACTED_CODEX_API_KEY]");
  text = text.replace(/\b\d{7,}:[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_TELEGRAM_TOKEN]");
  text = text.replace(/\b(?:sk|sess|proj)-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_SECRET]");
  return text;
}

function formatDurationSeconds(seconds) {
  let remaining = Math.floor(seconds);
  const days = Math.floor(remaining / 86400);
  remaining -= days * 86400;
  const hours = Math.floor(remaining / 3600);
  remaining -= hours * 3600;
  const minutes = Math.floor(remaining / 60);
  remaining -= minutes * 60;
  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 || days > 0) parts.push(`${hours}h`);
  if (minutes > 0 || hours > 0 || days > 0) parts.push(`${minutes}m`);
  parts.push(`${remaining}s`);
  return parts.join(" ");
}
