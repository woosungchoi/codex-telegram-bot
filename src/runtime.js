import "dotenv/config";

// Importing this module initializes state and starts the Telegram polling loop.

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
  reasoningOptionsForModel
} from "./codex/models.js";
import { createChatOptionsController } from "./codex/chat_options_controller.js";
import { createCodexSessionRuntime } from "./codex/session_runtime.js";
import { replyCodexSkillsStatus } from "./codex/skills_status.js";
import {
  CODEX_TRANSPORT_APP_SERVER_DIRECT,
  CODEX_TRANSPORT_SDK
} from "./codex/thread_factory.js";
import { readConfig as readRuntimeConfig } from "./config.js";
import { createCleanupController } from "./maintenance/cleanup_controller.js";
import { createBackupController } from "./maintenance/backup_controller.js";
import { createCleanupRuntime } from "./maintenance/cleanup_runtime.js";
import { createCodexMaintenanceController } from "./maintenance/runtime_controller.js";
import { createQueueRuntimeController } from "./queue/runtime_controller.js";
import {
  createRuntimeSettingsController,
  loadRuntimeState,
  parseRequiredBoolean,
  saveRuntimeState
} from "./runtime/state_store.js";
import { createRuntimeRedactor } from "./runtime/redaction.js";
import { createExecutionComposition } from "./runtime/execution_composition.js";
import { registerRuntimeRoutes } from "./runtime/route_composition.js";
import { code } from "./telegram/html.js";
import {
  createTelegramApiAgent,
  summarizeTelegramError
} from "./telegram/api.js";
import { createTelegramRuntimeContext } from "./telegram/runtime_context.js";
import { createTelegramRuntimeResponder } from "./telegram/runtime_responder.js";
import { createTelegramCommandMenu } from "./telegram/command_menu.js";
import { createRuntimeStatusSupport } from "./status/runtime_status.js";
import {
  createRuntimeDiagnostics,
  readCommandOutput,
  readJsonFile,
  readPackageJson
} from "./status/runtime_diagnostics.js";
import {
  buildUploadCleanupPlanFromDisk,
  createUploadCleanupPlanLogEntry,
  createUploadCleanupPlanRecord,
  shouldRunUploadCleanup
} from "./uploads.js";
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
import { createModelPresenter } from "./ui/model_presenter.js";
import { createOperationsPresenter } from "./ui/operations_presenter.js";
import { createRuntimePanelController } from "./ui/runtime_panel_controller.js";
import { createSettingsCallbackController } from "./ui/settings_callback_controller.js";
import { createToolCallbackController } from "./ui/tool_callback_controller.js";
import {
  createRuntimeLocalization,
  parseLanguage,
  parseLocale,
  parseTimeZone
} from "./ui/runtime_localization.js";
import { sleep, withTimeout } from "./utils/async.js";
import { formatOptional, truncate, unique } from "./utils/text.js";
import { formatDurationSeconds } from "./utils/time.js";

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
  liveProgressSource: new Set(["agent", "activity", "both"]),
  liveProgressDeletePolicy: new Set(["always", "on_success", "never"])
};

const config = readRuntimeConfig();
const { redactText, redactValue } = createRuntimeRedactor(config);
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
const {
  cleanupCount,
  formatText: tf,
  formatTextForLanguage: ltf,
  language: uiLanguage,
  locale: uiLocale,
  text: t,
  textForLanguage: lt,
  timeZone: uiTimeZone
} = createRuntimeLocalization({ state, config });
const { registerTelegramCommands } = createTelegramCommandMenu({
  bot,
  language: uiLanguage,
  timing: {
    sleep,
    withTimeout
  },
  summarizeError: summarizeTelegramError
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
let codexSessionRuntime = null;
let modelPresenter = null;
let executionRuntime = null;
const {
  answerUiCallback,
  deleteTrackedProgressMessages,
  editMessageQuietly,
  editOrReplyHtml,
  editSelectionMessageStrict,
  helpTextHtml,
  reactQuietly,
  replyCodexAnswer,
  replyDocumentQuietly,
  replyHtml,
  replyTrackedProgressHtml,
  sendHtmlMessage
} = createTelegramRuntimeResponder({
  bot,
  settings: {
    runtimeValue
  },
  localization: {
    text: t
  }
});
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
  state,
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
    runPreparedQueue: (...args) => executionRuntime.runPreparedTurnQueue(...args)
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
    list: (...args) => modelPresenter.listCodexModels(...args)
  },
  telegram: {
    commandName,
    formatOptionsHtml: (...args) => modelPresenter.formatOptionsHtml(...args),
    getChatKey,
    getCommandArgs,
    rejectIfActive: (...args) => codexSessionRuntime.rejectIfActive(...args),
    replyHtml
  },
  validation: {
    ensureDirectory: (...args) => codexSessionRuntime.ensureDirectory(...args),
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
modelPresenter = createModelPresenter({
  settings: {
    config
  },
  state,
  chats: {
    effectiveModelSlug,
    get: getChatState,
    getEffectiveOptions
  },
  localization: {
    language: uiLanguage,
    locale: uiLocale,
    text: t,
    timeZone: uiTimeZone
  },
  formatting: {
    keyValue: formatKeyValueHtml,
    optional: formatOptional
  }
});
const {
  formatFastStatusHtml,
  formatOptionsHtml,
  formatReasoningPromptHtml,
  formatStandaloneFastPromptHtml,
  formatStandaloneReasoningPromptHtml,
  formatStandaloneSelectionResultHtml,
  listCodexModels
} = modelPresenter;
codexSessionRuntime = createCodexSessionRuntime({
  settings: {
    config,
    runtimeValue
  },
  activeTurns,
  threadCache,
  codexClients,
  chats: {
    get: getChatState,
    getEffectiveOptions
  },
  persistence: {
    save: () => saveState(config.stateFile, state)
  },
  telegram: {
    replyHtml
  }
});
const {
  codexTransport,
  codexWorkerMode,
  createCodexThread,
  ensureDirectory,
  findCodexSessionFile,
  getOrCreateThread,
  getWorkerClient,
  isStatusQuestion,
  listFiles,
  listRecentCodexSessions,
  readSessionMeta,
  rejectIfActive,
  rememberThread,
  resumeCodexThread,
  startCodexThread,
  threadTransport,
  useWorkerSidecar
} = codexSessionRuntime;
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
  formatConfigHtml,
  formatLogsHtml,
  formatPrefsHtml,
  formatUploadCleanupPlanHtml,
  formatUploadCleanupProcessingHtml,
  formatUploadCleanupResultHtml,
  formatWhoamiHtml
} = createOperationsPresenter({
  settings: {
    config,
    runtimeValue
  },
  threadCache,
  chats: {
    get: getChatState,
    getEffectiveOptions
  },
  queue: {
    mode: getQueueMode
  },
  telegram: {
    getCommandArgs
  },
  formatting: {
    bytes: formatBytes,
    count: cleanupCount,
    dateTime: formatDateTime,
    keyValue: formatKeyValueHtml,
    optional: formatOptional,
    redactText
  },
  commands: {
    readOutput: readCommandOutput
  }
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
executionRuntime = createExecutionComposition({
  config,
  state,
  activeTurns,
  threadCache,
  pendingTurns,
  runtimeValue,
  saveState: () => saveState(config.stateFile, state),
  getChatState,
  getEffectiveOptions,
  defaultChatOptions,
  buildTurnOptions,
  truncate,
  text: t,
  uiLanguage,
  textForLanguage: lt,
  formatTextForLanguage: ltf,
  redactText,
  getChatKey,
  replyTrackedProgressHtml,
  replyHtml,
  editMessageQuietly,
  readLatestTokenCount,
  formatKeyValueHtml,
  startCodexThread,
  threadTransport,
  codexTransport,
  getWorkerClient,
  codexWorkerMode,
  createQueueItemId,
  dequeuePendingTurn,
  enqueuePendingTurn,
  enqueuePendingTurnFront,
  getQueueMode,
  getPendingTurns,
  hasPendingFinalDelivery,
  isQueuePaused,
  pruneExpiredPendingTurns,
  isRecoveryActive,
  applyPersonaPrompt,
  buildReplyContext,
  ensureTurnContext,
  telegramMessageMeta,
  getOrCreateThread,
  rememberThread,
  useWorkerSidecar,
  deleteTrackedProgressMessages,
  reactQuietly,
  replyCodexAnswer,
  buildStatusDetails,
  formatStatusHtml,
  isStatusQuestion,
  trackSideTurn,
  untrackSideTurn,
  persistPendingTurns,
  startQueueDrainIfIdle,
  createCodexThread,
  createSyntheticCtx,
  telegramNotifyExtra,
  sendHtmlMessage,
  formatRestartRecoveredHtml,
  formatRestartScheduledHtml,
  stopBot: (signalName) => bot.stop(signalName),
  exit: (codeValue) => process.exit(codeValue),
  sleep
});
const {
  cancelWorkerJobOnce,
  handleCodexMessage,
  handleProcessSignal,
  handleRestartCommand,
  markActiveTurnStopped,
  refreshUsageSample,
  runCodexTurn,
  scheduleStartupRecovery,
  startRecoveryScheduler
} = executionRuntime;
hydratePendingTurnsFromState();

({ adminCommandHandlers } = registerRuntimeRoutes({
  bot,
  config,
  state,
  valid: VALID,
  activeTurns,
  pendingTurns,
  threadCache,
  usageRefreshes,
  runtimeValue,
  applyPersonaPrompt,
  getChatState,
  getEffectiveOptions,
  invalidateThreadCache,
  rejectIfActive,
  rememberThread,
  resumeCodexThread,
  startCodexThread,
  listRecentCodexSessions,
  runCodexTurn,
  formatFastStatusHtml,
  listCodexModels,
  sendStandaloneModelSelection,
  sendStandaloneReasoningSelection,
  formatOptionsHtml,
  updateOptionCommand,
  updateOptionValue,
  helpTextHtml,
  sendPanel,
  buildStatusDetails,
  formatStatusHtml,
  statusKeyboard,
  pruneExpiredPendingTurns,
  getChatKey,
  getCommandArgs,
  reactQuietly,
  replyHtml,
  text: t,
  formatKeyValueHtml,
  unique,
  ensureDirectory,
  saveState: () => saveState(config.stateFile, state),
  formatConfigHtml,
  formatDoctorHtml,
  formatHealthHtml,
  formatLogsHtml,
  formatWhoamiHtml,
  createChatExport,
  createStateBackup,
  cancelWorkerJobOnce,
  clearRecoveryPendingTurns,
  formatRecoveryStatusHtml,
  handleRestartCommand,
  markActiveTurnStopped,
  scheduleStartupRecovery,
  clearPendingTurns,
  formatQueueHtml,
  formatQueueModeHtml,
  queueKeyboard,
  removePendingTurn,
  setQueueMode,
  setQueuePaused,
  startQueueDrainIfIdle,
  stopSideTurns,
  appendCleanupLog,
  createCleanupPlan,
  createUploadCleanupPlan,
  createUploadCleanupPlanLogEntry,
  createUploadCleanupPlanRecord,
  formatUploadCleanupPlanHtml,
  sendCleanupPlan,
  uploadCleanupKeyboard,
  editOrReplyHtml,
  replyDocumentQuietly,
  formatBytes,
  formatPrefsHtml,
  answerCleanupCallback,
  answerUploadCleanupCallback,
  applyCleanupPlan,
  editCleanupMessage,
  editCleanupProcessingMessage,
  editUploadCleanupMessage,
  formatDateTime,
  formatCleanupIgnoredHtml,
  formatCleanupResultHtml,
  formatUploadCleanupProcessingHtml,
  formatUploadCleanupResultHtml,
  movePendingTurn,
  getSideTurnCount,
  handleMenuClose,
  handleSettingsModelSelection,
  handleSettingsReasoningSelection,
  handleStandaloneSelectionCancel,
  handleStandaloneFastSelection,
  handleStandaloneModelSelection,
  handleStandaloneReasoningSelection,
  settingsPanelHtml,
  handleQueueButton,
  handleSettingButton,
  handleToolButton,
  rejectCallbackIfActive,
  refreshUsageSample,
  summarizeTelegramError,
  backToMainKeyboard,
  inlineKeyboard,
  settingsKeyboard,
  withMenuCloseButton,
  withToolsBack,
  withTimeout,
  downloadTelegramFile,
  downloadTelegramPdf,
  extensionFromMime,
  formatUploadedPdfUploadHtml,
  getFreshLastPdfUpload,
  handleCodexMessage,
  rememberLastPdfUpload
}));
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

async function rejectCallbackIfActive(ctx, chatKey) {
  if (!activeTurns.has(chatKey)) return false;
  await editOrReplyHtml(ctx, `Codex turn is already running. Use ${code("/stop")} first. Plain messages can still be queued.`, statusKeyboard(chatKey));
  return true;
}
