import "dotenv/config";

// Importing this module initializes state and starts the Telegram polling loop.

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Telegraf } from "telegraf";
import { bootstrapBot } from "./app/bootstrap.js";
import {
  appServerDirectArgs,
  appServerThreadReadEvents,
  readAppServerThread
} from "./codex/app_server.js";
import {
  findCodexModel,
  isReasoningEffortSupported,
  readCodexModelCatalog,
  reasoningOptionsForModel
} from "./codex/models.js";
import {
  mergeAdditionalDirectories,
  planModelReasoningTransition
} from "./codex/options.js";
import { buildStyleInstructionPrompt } from "./codex/prompts.js";
import { readCodexSessionBackfill } from "./codex/session_backfill.js";
import { isCodexSkillsView, replyCodexSkillsStatus } from "./codex/skills_status.js";
import { applyCodexStreamEvent, codexStreamItems, codexStreamResult, createCodexStreamState } from "./codex/stream.js";
import { createCodexStreamWatchdog, STREAM_IDLE_TIMEOUT_MESSAGE } from "./codex/watchdog.js";
import { createTurnRuntimeController } from "./codex/turn_controller.js";
import { analyzeContextPressure, resolveAutoCompactTokenLimit } from "./codex/compact.js";
import {
  CODEX_TRANSPORT_APP_SERVER_DIRECT,
  CODEX_TRANSPORT_SDK,
  createCodexThread as createCodexThreadForTransport,
  threadTransport as detectThreadTransport
} from "./codex/thread_factory.js";
import { readConfig as readRuntimeConfig } from "./config.js";
import { renderHandoffMarkdown, sanitizeHandoffFilename, sessionHighlightFromItem } from "./handoff.js";
import { TELEGRAM_LANGUAGE_CODES, VALID_LANGUAGES, textFor } from "./i18n.js";
import {
  appendPrivateFile,
  ensurePrivateDirectory,
  writePrivateFile,
  writePrivateFileAtomic
} from "./fs/private.js";
import { parseCodexMaintenanceOutput } from "./maintenance/codex.js";
import { createCleanupController } from "./maintenance/cleanup_controller.js";
import {
  dequeueNextTurn,
  enqueueTurn,
  hydratePendingQueues,
  moveTurn,
  pruneExpiredTurns,
  removeRecoveryTurns,
  removeTurn,
  serializePendingTurn
} from "./queue.js";
import { authorizeTelegramUpdate } from "./security.js";
import {
  normalizeTelegramId,
  telegramChatActionExtraFromMeta,
  telegramReplyExtraFromMeta,
  telegramSyntheticMessageFromMeta
} from "./telegram/context.js";
import { b, code, pre, stripHtml } from "./telegram/html.js";
import {
  createTelegramApiAgent,
  editOrReplyTelegramHtml,
  replyTelegramHtml,
  runTelegramProgressBestEffort,
  sendTelegramHtml,
  summarizeTelegramError
} from "./telegram/api.js";
import {
  createUploadedPdfRecord,
  formatPdfReferenceText,
  formatUploadedPdfHtml,
  isFreshPdfUpload,
  isPdfDocument,
  mergePdfReferences,
  planTelegramDocumentInput,
  shouldUseRecentPdfUpload
} from "./telegram/pdf.js";
import { replyFormattedCodexAnswer } from "./telegram/codex_answer.js";
import { formatCodexAnswerMarkdownHtml, formatCodexAnswerSafeHtml } from "./telegram/markdown.js";
import { splitText } from "./telegram/split.js";
import { isRegisteredTelegramCommandText } from "./telegram_commands.js";
import { formatCodexUsageSummary } from "./status_usage.js";
import {
  buildUploadCleanupPlanFromDisk,
  confirmUploadCleanupPlan,
  createUploadCleanupPlanLogEntry,
  createUploadCleanupPlanRecord,
  createUploadCleanupResultLogEntry,
  deleteUploadCandidates,
  shouldRunUploadCleanup
} from "./uploads.js";
import { appendRecoveryJournal, summarizeStreamEvent } from "./recovery/journal.js";
import { createRuntimeRecoveryController } from "./recovery/runtime_controller.js";
import {
  applyRecoveryThreadToChatState,
  clearCompletedRecovery,
  markRecoveryAttempt
} from "./recovery/startup.js";
import {
  ensureRecoveryDir,
  readActiveTurnSnapshots,
  readRecoveryDedupe,
  readRestartMarker,
  replaceActiveTurnSnapshot,
  removeActiveTurnSnapshot,
  upsertActiveTurnSnapshot
} from "./recovery/state.js";
import { startRecoveryBackfillPoller } from "./recovery/backfill_poller.js";
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
import { createWorkerClient } from "./worker/client.js";
import { createWorkerRuntimeController } from "./worker/runtime_controller.js";
import {
  hasPendingWorkerDelivery,
  markWorkerDeliveryFailed,
  markWorkerDeliveryResultReady,
  markWorkerDeliverySending,
  markWorkerDeliverySent,
  markWorkerDeliveryStreaming,
  normalizeWorkerDeliveryEntry,
  summarizeWorkerDeliveryStatus,
  workerDeliveryKey
} from "./worker/delivery.js";

const execFileAsync = promisify(execFile);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STREAM_BACKFILLED_MESSAGE = "stream_backfilled";

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
const state = await loadState(config.stateFile);
const threadCache = new Map();
const activeTurns = new Map();
const pendingTurns = new Map();
const codexClients = new Map();
const sideTurns = new Map();
const usageRefreshes = new Map();
const selectionFlows = createSelectionFlowStore();
const {
  approvalKeyboard,
  backToMainKeyboard,
  booleanOptionKeyboard,
  emptyInlineKeyboard,
  fastKeyboard,
  inlineKeyboard,
  languageKeyboard,
  liveProgressKeyboard,
  localeKeyboard,
  mainPanelKeyboard,
  pathsKeyboard,
  previousPanelFor,
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
  webSearchKeyboard,
  withMenuCloseButton,
  withPreviousPanelButton
} = createRuntimeKeyboardViews({
  text: t,
  hasActiveTurn: (chatKey) => activeTurns.has(chatKey),
  sideTurnCount: getSideTurnCount,
  currentLanguage: uiLanguage,
  currentTimeZone: uiTimeZone,
  currentLocale: uiLocale
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

bot.catch(async (error, ctx) => {
  const errorSummary = summarizeTelegramError(error);
  console.error("Unhandled Telegram update error:", errorSummary);
  if (ctx.chat) {
    await replyHtml(ctx, `${b("Telegram bot error")}\n${code(errorSummary.description)}`).catch(() => {});
  }
});

bot.use(async (ctx, next) => {
  const authorization = authorizeTelegramUpdate(ctx, config);
  if (!authorization.ok) {
    if (ctx.message) await ctx.reply("Unauthorized.");
    return;
  }
  return next();
});

bot.start(async (ctx) => {
  await replyHtml(ctx, helpTextHtml());
});

bot.help(async (ctx) => {
  await replyHtml(ctx, helpTextHtml());
});

bot.command("menu", async (ctx) => {
  await sendPanel(ctx, "main");
});

bot.command("new", async (ctx) => {
  await handleNewCommand(ctx);
});

async function handleNewCommand(ctx) {
  const chatKey = getChatKey(ctx);
  if (await rejectIfActive(ctx, chatKey)) return;

  const previousThreadId = getChatState(chatKey).threadId || threadCache.get(chatKey)?.id || "";
  const thread = startCodexThread(chatKey);
  threadCache.set(chatKey, thread);
  const chat = getChatState(chatKey);
  delete chat.threadId;
  chat.updatedAt = new Date().toISOString();
  await saveState(config.stateFile, state);

  const abortController = new AbortController();
  activeTurns.set(chatKey, { abortController });
  let finalReaction = "";
  await reactQuietly(ctx, config.telegramThinkingReaction);
  try {
    await runCodexTurn(
      ctx,
      chatKey,
      thread,
      applyPersonaPrompt(t("newThreadPersonaPrompt")),
      abortController.signal
    );
    await rememberThread(chatKey, thread);
    await replyHtml(ctx, formatKeyValueHtml("New Codex thread started.", [
      ["Previous thread", previousThreadId || "none"],
      ["New thread", thread.id || "unknown"],
      ["Workdir", getEffectiveOptions(chatKey).workingDirectory]
    ]));
    finalReaction = config.telegramCompleteReaction;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    finalReaction = abortController.signal.aborted ? config.telegramStoppedReaction : config.telegramErrorReaction;
    await replyHtml(ctx, `<b>Failed to start new Codex thread</b>\n${code(message)}`);
  } finally {
    await reactQuietly(ctx, finalReaction, finalReaction === config.telegramCompleteReaction);
    activeTurns.delete(chatKey);
  }
}

bot.command("resume", async (ctx) => {
  await handleResumeCommand(ctx);
});

bot.command("resume_last", async (ctx) => {
  await handleResumeCommand(ctx, "last");
});

async function handleResumeCommand(ctx, overrideArg = null) {
  const chatKey = getChatKey(ctx);
  if (await rejectIfActive(ctx, chatKey)) return;

  const arg = overrideArg ?? getCommandArgs(ctx).trim();
  let threadId = arg;
  let session = null;
  if (!threadId || threadId.toLowerCase() === "last") {
    session = (await listRecentCodexSessions(1))[0] ?? null;
    threadId = session?.id ?? "";
  }

  if (!threadId) {
    await replyHtml(ctx, `No Codex session found. Use ${code("/new")} to start one.`);
    return;
  }

  const thread = resumeCodexThread(chatKey, threadId);
  threadCache.set(chatKey, thread);
  const chat = getChatState(chatKey);
  chat.threadId = threadId;
  chat.updatedAt = new Date().toISOString();
  await saveState(config.stateFile, state);

  await replyHtml(ctx, formatKeyValueHtml("Resumed Codex thread.", [
    ["Thread", threadId],
    ...(session ? [["Source", session.cwd], ["Time", session.timestamp]] : [])
  ]));
}

bot.command("threads", async (ctx) => {
  const sessions = await listRecentCodexSessions(8);
  if (sessions.length === 0) {
    await replyHtml(ctx, "No Codex sessions found.");
    return;
  }

  const lines = [b("Recent Codex sessions:")];
  for (const session of sessions) {
    lines.push(
      "",
      code(session.id),
      `- time: ${code(session.timestamp)}`,
      `- cwd: ${code(session.cwd)}`,
      `- source: ${code(`${session.source}/${session.originator}`)}`,
      `- resume: ${code(`/resume ${session.id}`)}`
    );
  }
  await replyHtml(ctx, lines.join("\n"));
});

bot.command("status", async (ctx) => {
  const chatKey = getChatKey(ctx);
  await pruneExpiredPendingTurns(chatKey, ctx);
  await replyHtml(ctx, formatStatusHtml(chatKey, await buildStatusDetails(chatKey)), statusKeyboard(chatKey));
});

bot.command("options", async (ctx) => {
  await replyHtml(ctx, formatOptionsHtml(getChatKey(ctx)));
});

bot.command("settings", async (ctx) => {
  await sendPanel(ctx, "settings");
});

bot.command("model", async (ctx) => {
  const chatKey = getChatKey(ctx);
  const value = getCommandArgs(ctx).trim();
  if (value) {
    await updateOptionCommand(ctx, "model", "model name or off");
    return;
  }
  if (await rejectIfActive(ctx, chatKey)) return;
  await sendStandaloneModelSelection(ctx, chatKey);
});

bot.command("model_off", async (ctx) => {
  await updateOptionValue(ctx, "model", "off");
});

bot.command("workdir", async (ctx) => {
  await updateOptionCommand(ctx, "workingDirectory", "absolute directory");
});

bot.command("workdir_default", async (ctx) => {
  await updateOptionValue(ctx, "workingDirectory", "default");
});

bot.command("sandbox", async (ctx) => {
  await updateOptionCommand(ctx, "sandboxMode", [...VALID.sandbox].join("|"));
});

bot.command("sandbox_read_only", async (ctx) => {
  await updateOptionValue(ctx, "sandboxMode", "read-only");
});

bot.command("sandbox_workspace_write", async (ctx) => {
  await updateOptionValue(ctx, "sandboxMode", "workspace-write");
});

bot.command("sandbox_danger_full_access", async (ctx) => {
  await updateOptionValue(ctx, "sandboxMode", "danger-full-access");
});

bot.command("sandbox_default", async (ctx) => {
  await updateOptionValue(ctx, "sandboxMode", "default");
});

bot.command("approval", async (ctx) => {
  await updateOptionCommand(ctx, "approvalPolicy", [...VALID.approval].join("|"));
});

bot.command("approval_never", async (ctx) => {
  await updateOptionValue(ctx, "approvalPolicy", "never");
});

bot.command("approval_on_request", async (ctx) => {
  await updateOptionValue(ctx, "approvalPolicy", "on-request");
});

bot.command("approval_on_failure", async (ctx) => {
  await updateOptionValue(ctx, "approvalPolicy", "on-failure");
});

bot.command("approval_untrusted", async (ctx) => {
  await updateOptionValue(ctx, "approvalPolicy", "untrusted");
});

bot.command("approval_default", async (ctx) => {
  await updateOptionValue(ctx, "approvalPolicy", "default");
});

bot.command("reasoning", async (ctx) => {
  const chatKey = getChatKey(ctx);
  const value = getCommandArgs(ctx).trim();
  if (value) {
    await updateOptionValue(ctx, "modelReasoningEffort", value.toLowerCase());
    return;
  }
  if (await rejectIfActive(ctx, chatKey)) return;
  await sendStandaloneReasoningSelection(ctx, chatKey);
});

for (const shortcut of [
  "reasoning_minimal",
  "reasoning_low",
  "reasoning_medium",
  "reasoning_high",
  "reasoning_xhigh",
  "reasoning_max",
  "reasoning_ultra",
  "reasoning_default"
]) {
  const reasoning = shortcut.slice("reasoning_".length);
  bot.command(shortcut, async (ctx) => {
    await updateOptionValue(ctx, "modelReasoningEffort", reasoning);
  });
}

bot.command("fast", async (ctx) => {
  await handleFastCommand(ctx);
});

bot.command("fast_on", async (ctx) => {
  await handleFastCommand(ctx, "on");
});

bot.command("fast_off", async (ctx) => {
  await handleFastCommand(ctx, "off");
});

bot.command("fast_status", async (ctx) => {
  await handleFastCommand(ctx, "status");
});

async function handleFastCommand(ctx, overrideArg = null) {
  const chatKey = getChatKey(ctx);
  if (await rejectIfActive(ctx, chatKey)) return;
  const arg = (overrideArg ?? getCommandArgs(ctx).trim()).toLowerCase();
  const chat = getChatState(chatKey);
  const fastEnabled = getEffectiveOptions(chatKey).serviceTier === "fast";
  const models = await listCodexModels();

  if (arg === "status") {
    await replyHtml(ctx, formatFastStatusHtml(chatKey, models));
    return;
  }

  if (!arg || arg === "toggle") {
    if (fastEnabled) delete chat.options.serviceTier;
    else chat.options.serviceTier = "fast";
  } else if (["on", "true", "yes", "1"].includes(arg)) {
    chat.options.serviceTier = "fast";
  } else if (["off", "false", "no", "0", "default"].includes(arg)) {
    delete chat.options.serviceTier;
  } else {
    await replyHtml(ctx, `Usage: ${code("/fast")}, ${code("/fast_on")}, ${code("/fast_off")}, or ${code("/fast_status")}`);
    return;
  }

  invalidateThreadCache(chatKey);
  await saveState(config.stateFile, state);
  await replyHtml(ctx, `${b("Fast service tier updated.")}\n\n${formatFastStatusHtml(chatKey, models)}`);
}

bot.command("websearch", async (ctx) => {
  await updateOptionCommand(ctx, "webSearchMode", [...VALID.webSearch].join("|"));
});

for (const mode of ["disabled", "cached", "live", "default"]) {
  bot.command(`websearch_${mode}`, async (ctx) => {
    await updateOptionValue(ctx, "webSearchMode", mode);
  });
}

bot.command("network", async (ctx) => {
  await updateOptionCommand(ctx, "networkAccessEnabled", "on|off");
});

for (const value of ["on", "off", "default"]) {
  bot.command(`network_${value}`, async (ctx) => {
    await updateOptionValue(ctx, "networkAccessEnabled", value);
  });
}

bot.command("skipgit", async (ctx) => {
  await updateOptionCommand(ctx, "skipGitRepoCheck", "on|off");
});

for (const value of ["on", "off", "default"]) {
  bot.command(`skipgit_${value}`, async (ctx) => {
    await updateOptionValue(ctx, "skipGitRepoCheck", value);
  });
}

bot.command("adddir", async (ctx) => {
  const chatKey = getChatKey(ctx);
  if (await rejectIfActive(ctx, chatKey)) return;
  const dir = getCommandArgs(ctx).trim();
  if (!dir) {
    await replyHtml(ctx, `Usage: ${code("/adddir <absolute-directory>")}`);
    return;
  }
  await ensureDirectory(dir, "additional directory");
  const chat = getChatState(chatKey);
  chat.options.additionalDirectories = unique([...(chat.options.additionalDirectories ?? []), dir]);
  invalidateThreadCache(chatKey);
  await saveState(config.stateFile, state);
  await replyHtml(ctx, `Added directory: ${code(dir)}`);
});

bot.command("cleardirs", async (ctx) => {
  const chatKey = getChatKey(ctx);
  if (await rejectIfActive(ctx, chatKey)) return;
  const chat = getChatState(chatKey);
  delete chat.options.additionalDirectories;
  invalidateThreadCache(chatKey);
  await saveState(config.stateFile, state);
  await replyHtml(ctx, "Cleared additional directories.");
});

bot.command("stream", async (ctx) => {
  await updateOptionCommand(ctx, "streamEvents", "on|off");
});

for (const value of ["on", "off", "default"]) {
  bot.command(`stream_${value}`, async (ctx) => {
    await updateOptionValue(ctx, "streamEvents", value);
  });
}

bot.command("schema", async (ctx) => {
  const chatKey = getChatKey(ctx);
  if (await rejectIfActive(ctx, chatKey)) return;
  const value = getCommandArgs(ctx).trim();
  if (!value) {
    await replyHtml(ctx, `Usage: ${code("/schema <json-schema>")} or ${code("/schema off")}`);
    return;
  }
  const chat = getChatState(chatKey);
  if (value.toLowerCase() === "off") {
    delete chat.outputSchema;
    await saveState(config.stateFile, state);
    await replyHtml(ctx, "Structured output schema disabled.");
    return;
  }
  try {
    chat.outputSchema = JSON.parse(value);
  } catch (error) {
    await replyHtml(ctx, `<b>Invalid JSON schema</b>\n${code(error instanceof Error ? error.message : String(error))}`);
    return;
  }
  await saveState(config.stateFile, state);
  await replyHtml(ctx, "Structured output schema enabled for this chat.");
});

bot.command("schema_off", async (ctx) => {
  const chatKey = getChatKey(ctx);
  if (await rejectIfActive(ctx, chatKey)) return;
  const chat = getChatState(chatKey);
  delete chat.outputSchema;
  await saveState(config.stateFile, state);
  await replyHtml(ctx, "Structured output schema disabled.");
});

bot.command("config", async (ctx) => {
  await replyHtml(ctx, formatConfigHtml());
});

bot.command("doctor", async (ctx) => {
  await replyHtml(ctx, await formatDoctorHtml(getChatKey(ctx)));
});

bot.command("health", async (ctx) => {
  await replyHtml(ctx, await formatHealthHtml());
});

bot.command("tools", async (ctx) => {
  await sendPanel(ctx, "tools");
});

bot.command("skills", async (ctx) => {
  await replyCodexSkillsStatus(ctx, { config, runtimeValue, replyHtml, editOrReplyHtml }, { query: commandArgument(ctx.message?.text, "skills") });
});

bot.command("backup", async (ctx) => {
  const backup = await createStateBackup("manual");
  await replyHtml(ctx, formatKeyValueHtml("Backup created:", [
    ["file", backup.path],
    ["size", formatBytes(backup.bytes)],
    ["chats", backup.chatCount]
  ]));
  await replyDocumentQuietly(ctx, backup.path, "Codex Telegram Bot backup");
});

bot.command("export", async (ctx) => {
  const chatKey = getChatKey(ctx);
  const file = await createChatExport(chatKey);
  await replyHtml(ctx, formatKeyValueHtml("Chat export created:", [
    ["file", file.path],
    ["size", formatBytes(file.bytes)]
  ]));
  await replyDocumentQuietly(ctx, file.path, "Current chat export");
});

function commandArgument(text, command) {
  const trimmed = String(text || "").trimStart();
  const token = trimmed.split(/\s+/, 1)[0] || "";
  const bareCommand = token.replace(/^\//, "").split("@", 1)[0].toLowerCase();
  return bareCommand === command ? trimmed.slice(token.length).trim() : "";
}

bot.command("prefs", async (ctx) => {
  await handlePrefsCommand(ctx);
});

bot.command("prefs_reset", async (ctx) => {
  await handlePrefsCommand(ctx, "reset");
});

async function handlePrefsCommand(ctx, overrideArg = null) {
  const chatKey = getChatKey(ctx);
  const arg = (overrideArg ?? getCommandArgs(ctx).trim()).toLowerCase();
  if (arg === "reset") {
    if (await rejectIfActive(ctx, chatKey)) return;
    const chat = getChatState(chatKey);
    chat.options = {};
    delete chat.outputSchema;
    invalidateThreadCache(chatKey);
    await saveState(config.stateFile, state);
    await replyHtml(ctx, `${b("Preferences reset.")}\n\n${formatPrefsHtml(chatKey)}`);
    return;
  }
  if (arg) {
    await replyHtml(ctx, `Usage: ${code("/prefs")} or ${code("/prefs_reset")}`);
    return;
  }
  await replyHtml(ctx, formatPrefsHtml(chatKey));
}

bot.command("whoami", async (ctx) => {
  await replyHtml(ctx, formatWhoamiHtml(ctx));
});

bot.command("logs", async (ctx) => {
  await replyHtml(ctx, await formatLogsHtml(ctx));
});

bot.command("logs_error", async (ctx) => {
  await replyHtml(ctx, await formatLogsHtml(ctx, "error"));
});

bot.command("stop", async (ctx) => {
  await handleStopCommand(ctx);
});

async function handleStopCommand(ctx) {
  const chatKey = getChatKey(ctx);
  const active = activeTurns.get(chatKey);
  const stoppedSideTurns = stopSideTurns(chatKey);
  if (!active && stoppedSideTurns === 0) {
    await replyHtml(ctx, "No active Codex turn.");
    return;
  }
  if (active) {
    active.stopRequested = true;
    await markActiveTurnStopped(chatKey);
    cancelWorkerJobOnce(active, active.workerJobId);
    active.abortController?.abort();
  }
  const cleared = await clearPendingTurns(chatKey);
  await replyHtml(ctx, `Stop requested.${cleared > 0 ? ` Cleared queued turns: ${code(cleared)}` : ""}${stoppedSideTurns > 0 ? ` Stopped side turns: ${code(stoppedSideTurns)}` : ""}`);
}

bot.command("restart", async (ctx) => {
  await handleRestartCommand(ctx);
});

bot.command("restart_continue", async (ctx) => {
  await handleRestartCommand(ctx);
});

bot.command("recovery_status", async (ctx) => {
  await replyHtml(ctx, await formatRecoveryStatusHtml());
});

bot.command("recovery_resume", async (ctx) => {
  const started = await scheduleStartupRecovery({ force: true, notifyCtx: ctx });
  await replyHtml(ctx, started ? t("recoveryManualResumeStarted") : t("recoveryNoCandidates"));
});

bot.command("recovery_cancel", async (ctx) => {
  await clearCompletedRecovery(config.botRecoveryDir);
  await clearRecoveryPendingTurns();
  await replyHtml(ctx, t("recoveryCancelled"));
});

bot.command("queue", async (ctx) => {
  await handleQueueCommand(ctx);
});

bot.command("queue_pause", async (ctx) => {
  await handleQueueCommand(ctx, "pause");
});

bot.command("queue_resume", async (ctx) => {
  await handleQueueCommand(ctx, "resume");
});

bot.command("queue_mode", async (ctx) => {
  await handleQueueCommand(ctx, "mode");
});

for (const mode of ["safe", "interrupt", "side"]) {
  bot.command(`queue_mode_${mode}`, async (ctx) => {
    await handleQueueCommand(ctx, `mode ${mode}`);
  });
}

async function handleQueueCommand(ctx, overrideArg = null) {
  const chatKey = getChatKey(ctx);
  const arg = (overrideArg ?? getCommandArgs(ctx).trim()).toLowerCase();
  const [subcommand, value] = arg.split(/\s+/, 2);
  if (subcommand === "mode") {
    if (!value) {
      await replyHtml(ctx, formatQueueModeHtml(chatKey));
      return;
    }
    if (!VALID.queueMode.has(value)) {
      await replyHtml(ctx, `Usage: ${code("/queue_mode")} or ${code("/queue_mode_safe|interrupt|side")}`);
      return;
    }
    await setQueueMode(chatKey, value);
    await replyHtml(ctx, `${b(t("queueUpdatedTitle"))}\n\n${formatQueueModeHtml(chatKey)}`);
    return;
  }
  if (arg === "pause") {
    await setQueuePaused(chatKey, true);
    await replyHtml(ctx, `${b(t("queuePausedTitle"))}\n${t("queuePausedDetail")}\n\n${formatQueueHtml(chatKey)}`, queueKeyboard(chatKey));
    return;
  }
  if (arg === "resume") {
    await setQueuePaused(chatKey, false);
    const started = await startQueueDrainIfIdle(chatKey, ctx);
    await replyHtml(ctx, `${b(t("queueResumedTitle"))}${started ? `\n${t("queueProcessingRestarted")}` : ""}\n\n${formatQueueHtml(chatKey)}`, queueKeyboard(chatKey));
    return;
  }
  if (arg && arg !== "status") {
    await replyHtml(ctx, `Usage: ${code("/queue")}, ${code("/queue_pause")}, ${code("/queue_resume")}, or ${code("/queue_mode")}`);
    return;
  }
  await pruneExpiredPendingTurns(chatKey, ctx);
  await replyHtml(ctx, formatQueueHtml(chatKey), queueKeyboard(chatKey));
}

bot.command("cancelqueue", async (ctx) => {
  const chatKey = getChatKey(ctx);
  const arg = getCommandArgs(ctx).trim();
  const cleared = arg ? await removePendingTurn(chatKey, arg) : await clearPendingTurns(chatKey);
  await replyHtml(ctx, cleared > 0 ? `Cleared queued turns: ${code(cleared)}` : "No queued Codex turns.");
});

bot.command("forget", async (ctx) => {
  const chatKey = getChatKey(ctx);
  if (await rejectIfActive(ctx, chatKey)) return;
  threadCache.delete(chatKey);
  delete state.chats[chatKey];
  delete state.queues[chatKey];
  pendingTurns.delete(chatKey);
  await saveState(config.stateFile, state);
  await replyHtml(ctx, "Forgot the Codex thread and chat-specific options.");
});

bot.command("cleanup", async (ctx) => {
  await handleCleanupCommand(ctx);
});

bot.command("cleanup_status", async (ctx) => {
  await handleCleanupCommand(ctx, "status");
});

bot.command("cleanup_uploads", async (ctx) => {
  const plan = await createUploadCleanupPlan({ dryRun: true });
  const record = createUploadCleanupPlanRecord(plan);
  state.uploadCleanup.plans[record.id] = record;
  await appendCleanupLog(createUploadCleanupPlanLogEntry(plan, { planId: record.id, at: record.createdAt }));
  await saveState(config.stateFile, state);
  await replyHtml(ctx, formatUploadCleanupPlanHtml(plan, record), uploadCleanupKeyboard(record.id));
});

bot.command("cleanup_uploads_confirm", async (ctx) => {
  await replyHtml(ctx, `${b("Upload cleanup confirmation changed")}\nRun ${code("/cleanup_uploads")} and press the ${code("Confirm upload cleanup")} button. This command no longer deletes files.`);
});

async function handleCleanupCommand(ctx, overrideArg = null) {
  const arg = (overrideArg ?? getCommandArgs(ctx).trim()).toLowerCase();
  if (!arg || arg === "status" || arg === "dry-run") {
    const plan = await createCleanupPlan("manual");
    await saveState(config.stateFile, state);
    await sendCleanupPlan(ctx, plan);
    return;
  }
  await replyHtml(ctx, `Usage: ${code("/cleanup")} or ${code("/cleanup_status")}`);
}

bot.action(/^cleanup:(quarantine|delete|both|ignore):([a-zA-Z0-9_-]+)$/, async (ctx) => {
  const [, action, planId] = ctx.match;
  const plan = state.cleanup?.plans?.[planId];
  if (!plan) {
    await answerCleanupCallback(ctx, "missing");
    await editCleanupMessage(ctx, `${b(t("cleanupPlanNotFoundTitle"))}\n${t("cleanupPlanNotFoundBody")}\n\n${t("cleanupFreshCandidatesPrompt")} ${code("/cleanup")}.`);
    return;
  }
  if (Date.now() > Date.parse(plan.expiresAt)) {
    await answerCleanupCallback(ctx, "expired");
    delete state.cleanup.plans[planId];
    await saveState(config.stateFile, state);
    await editCleanupMessage(ctx, `${b(t("cleanupPlanExpiredTitle"))}\n${t("cleanupApprovalExpired")}: ${code(formatDateTime(plan.expiresAt))}\n\n${t("cleanupFreshCandidatesPrompt")} ${code("/cleanup")}.`);
    return;
  }
  await answerCleanupCallback(ctx, action);
  await editCleanupProcessingMessage(ctx, action, plan);
  if (action === "ignore") {
    delete state.cleanup.plans[planId];
    await saveState(config.stateFile, state);
    await editCleanupMessage(ctx, formatCleanupIgnoredHtml(plan));
    return;
  }

  const result = await applyCleanupPlan(plan, action);
  delete state.cleanup.plans[planId];
  await appendCleanupLog({ type: "apply", action, planId, result, at: new Date().toISOString() });
  await saveState(config.stateFile, state);
  await editCleanupMessage(ctx, formatCleanupResultHtml(action, result, plan));
});

bot.action(/^upload_cleanup_confirm:([a-zA-Z0-9_-]+)$/, async (ctx) => {
  const [, planId] = ctx.match;
  const record = state.uploadCleanup?.plans?.[planId];
  const confirmation = confirmUploadCleanupPlan(record);
  if (!confirmation.ok) {
    await answerUploadCleanupCallback(ctx, confirmation.reason);
    if (confirmation.reason === "expired_plan" && state.uploadCleanup?.plans) {
      delete state.uploadCleanup.plans[planId];
      await saveState(config.stateFile, state);
    }
    await editUploadCleanupMessage(ctx, `${b("Upload cleanup plan unavailable")}\nRun ${code("/cleanup_uploads")} to generate a fresh preview.`);
    return;
  }

  await answerUploadCleanupCallback(ctx, "confirm");
  await editOrReplyHtml(ctx, formatUploadCleanupProcessingHtml(record), inlineKeyboard([
    [{ text: "Processing", callback_data: `upload_cleanup_processing:${planId}` }]
  ]));
  const result = await deleteUploadCandidates(confirmation.plan.candidates, { dryRun: false, rootDir: config.uploadDir });
  delete state.uploadCleanup.plans[planId];
  await appendCleanupLog(createUploadCleanupResultLogEntry(planId, confirmation.plan, result));
  await saveState(config.stateFile, state);
  await editUploadCleanupMessage(ctx, formatUploadCleanupResultHtml(confirmation.plan, result));
});

bot.action(/^upload_cleanup_processing:([a-zA-Z0-9_-]+)$/, async (ctx) => {
  await answerUploadCleanupCallback(ctx, "processing");
});

bot.action(/^cleanup:processing:([a-zA-Z0-9_-]+)$/, async (ctx) => {
  try {
    await ctx.answerCbQuery(t("cleanupAlreadyProcessing"));
  } catch (error) {
    console.warn("cleanup processing callback answer failed:", summarizeTelegramError(error));
  }
});

bot.action(/^queue:(cancel|up|next):([a-zA-Z0-9_-]+)$/, async (ctx) => {
  const [, action, turnId] = ctx.match;
  await ctx.answerCbQuery();
  const chatKey = getChatKey(ctx);
  await pruneExpiredPendingTurns(chatKey, ctx);
  let changed = 0;
  if (action === "cancel") changed = await removePendingTurn(chatKey, turnId);
  else if (action === "up") changed = await movePendingTurn(chatKey, turnId, "up");
  else if (action === "next") changed = await movePendingTurn(chatKey, turnId, "next");

  if (changed === 0) {
    await replyHtml(ctx, "Queue item not found. Run /queue to refresh.");
    return;
  }
  await replyHtml(ctx, formatQueueHtml(chatKey), queueKeyboard(chatKey));
});

bot.action(/^m:([a-f0-9]{6}):([a-zA-Z0-9._-]+|default)$/, async (ctx) => {
  const [, token, model] = ctx.match;
  await handleStandaloneModelSelection(ctx, token, model);
});

bot.action(/^r:([a-f0-9]{6}):([a-z0-9][a-z0-9_-]{0,49}|default)$/, async (ctx) => {
  const [, token, reasoning] = ctx.match;
  await handleStandaloneReasoningSelection(ctx, token, reasoning);
});

bot.action(/^f:([a-f0-9]{6}):(on|off)$/, async (ctx) => {
  const [, token, fast] = ctx.match;
  await handleStandaloneFastSelection(ctx, token, fast);
});

bot.action(/^x:([a-f0-9]{6})$/, async (ctx) => {
  const [, token] = ctx.match;
  await handleStandaloneSelectionCancel(ctx, token);
});

bot.action("ui:close:menu", async (ctx) => {
  await handleMenuClose(ctx);
});

bot.action(/^model:set:([a-zA-Z0-9._-]+|default)$/, async (ctx) => {
  const [, model] = ctx.match;
  await ctx.answerCbQuery();
  await handleSettingsModelSelection(ctx, model);
});

bot.action(/^reasoning:set:([a-z0-9][a-z0-9_-]{0,49}|default)$/, async (ctx) => {
  const [, reasoning] = ctx.match;
  await ctx.answerCbQuery();
  await handleSettingsReasoningSelection(ctx, reasoning);
});

bot.action(/^rm:([a-z0-9][a-z0-9_-]{0,49}|default)$/, async (ctx) => {
  const [, reasoning] = ctx.match;
  await ctx.answerCbQuery();
  await handleSettingsReasoningSelection(ctx, reasoning, { continueToFast: true });
});

bot.action(/^p:([a-z_]+)$/, async (ctx) => {
  const [, panel] = ctx.match;
  await ctx.answerCbQuery();
  await sendPanel(ctx, panel, { edit: true });
});

bot.action(/^q:(pause|resume|clear|mode)(?::(safe|interrupt|side))?$/, async (ctx) => {
  const [, action, value] = ctx.match;
  await ctx.answerCbQuery();
  await handleQueueButton(ctx, action, value || "");
});

bot.action(/^set:([a-z_]+):([a-z0-9_-]+)$/, async (ctx) => {
  const [, key, value] = ctx.match;
  await ctx.answerCbQuery();
  await handleSettingButton(ctx, key, value);
});

bot.action(/^tool:([a-z_]+)$/, async (ctx) => {
  const [, action] = ctx.match;
  await ctx.answerCbQuery();
  await handleToolButton(ctx, action);
});

bot.action(/^sk:([a-z]):([0-9]+)$/, async (ctx) => {
  const [, view, page] = ctx.match;
  await ctx.answerCbQuery();
  if (!isCodexSkillsView(view)) {
    await editOrReplyHtml(ctx, b("Invalid skills view"), withToolsBack());
    return;
  }
  await replyCodexSkillsStatus(ctx, { config, runtimeValue, replyHtml, editOrReplyHtml }, { edit: true, view, page: Number(page), extra: withToolsBack() });
});

bot.action(/^usage:(refresh|refresh_confirm)$/, async (ctx) => {
  const [, action] = ctx.match;
  await ctx.answerCbQuery();
  await handleUsageRefreshButton(ctx, action);
});

bot.action(/^act:(new|resume_last|stop|restart)$/, async (ctx) => {
  const [, action] = ctx.match;
  await ctx.answerCbQuery();
  if (action === "new") {
    await handleNewCommand(ctx);
  } else if (action === "resume_last") {
    await handleResumeCommand(ctx, "last");
  } else if (action === "stop") {
    await handleStopCommand(ctx);
  } else if (action === "restart") {
    await handleRestartCommand(ctx);
  }
});

bot.action(/^confirm:(q_clear|forget|prefs_reset)$/, async (ctx) => {
  const [, action] = ctx.match;
  await ctx.answerCbQuery();
  await handleConfirmButton(ctx, action);
});

bot.on("photo", async (ctx) => {
  await handleCodexMessage(ctx, ctx.message.caption?.trim() || "Analyze this image.", async () => {
    const photo = ctx.message.photo.at(-1);
    if (!photo) return [];
    return [await downloadTelegramFile(ctx, photo.file_id, ".jpg")];
  });
});

bot.on("document", async (ctx) => {
  const document = ctx.message.document;
  const documentPlan = planTelegramDocumentInput(document, ctx.message.caption, { imageFallbackText: "Analyze this image." });
  if (documentPlan.kind === "pdf_upload_only" || documentPlan.kind === "pdf_caption") {
    let record;
    try {
      record = await downloadTelegramPdf(ctx, document, ctx.message);
      await rememberLastPdfUpload(ctx, record);
    } catch (error) {
      await replyHtml(ctx, `<b>Failed to prepare Codex input</b>\n${code(error instanceof Error ? error.message : String(error))}`);
      return;
    }
    if (documentPlan.kind === "pdf_upload_only") {
      await replyHtml(ctx, formatUploadedPdfUploadHtml(record));
      return;
    }
    await handleCodexMessage(ctx, mergePdfReferences(documentPlan.text, [record]), async () => []);
    return;
  }
  if (documentPlan.kind !== "image") {
    await replyHtml(ctx, t("unsupportedDocument"));
    return;
  }
  const ext = path.extname(document.file_name ?? "") || extensionFromMime(document.mime_type);
  await handleCodexMessage(ctx, documentPlan.text, async () => {
    return [await downloadTelegramFile(ctx, document.file_id, ext)];
  });
});

bot.on("text", async (ctx) => {
  const text = ctx.message.text.trim();
  if (!text || isRegisteredTelegramCommandText(ctx.message)) return;
  const recentPdf = shouldUseRecentPdfUpload(text) ? getFreshLastPdfUpload(getChatKey(ctx)) : null;
  await handleCodexMessage(ctx, recentPdf ? mergePdfReferences(text, [recentPdf]) : text, async () => []);
});

bot.on("message", async (ctx) => {
  await replyHtml(ctx, t("unsupportedMessage"));
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

async function runCodexTurn(ctx, chatKey, thread, input, signal, workingMessageId, liveProgress = null, options = {}) {
  const linkedAbort = createLinkedAbortController(signal);
  const turnOptions = buildTurnOptions(chatKey, linkedAbort.controller.signal);
  if (!getEffectiveOptions(chatKey).streamEvents) {
    try {
      return await thread.run(input, turnOptions);
    } finally {
      linkedAbort.cleanup();
    }
  }

  const streamStartedAt = Date.now();
  await recordCodexStreamStarted(chatKey, options.turnKind || "user");
  const { events } = await thread.runStreamed(input, turnOptions);
  const streamState = createCodexStreamState();
  let lastProgressAt = 0;
  let firstItemSeen = false;
  let streamOutcome = "completed";
  const progressState = liveProgress;
  const isRecoveryTurn = options.turnKind === "recovery";
  let backfillPollRecovered = false;
  const watchdog = createCodexStreamWatchdog({
    noticeMs: runtimeValue("codexStreamIdleNoticeMs"),
    abortMs: runtimeValue("codexStreamIdleAbortMs"),
    onNotice: ({ idleMs }) => recordStreamIdleNotice(ctx, chatKey, idleMs, isRecoveryTurn),
    onTimeout: ({ idleMs }) => recordStreamIdleTimeout(chatKey, idleMs),
    abort: (error) => linkedAbort.controller.abort(error)
  });
  const backfillPoller = isRecoveryTurn
    ? startCodexStreamBackfillPoller(chatKey, thread, streamState, {
      sinceMs: streamStartedAt,
      intervalMs: runtimeValue("botRecoveryBackfillPollMs"),
      onRecovered: () => {
        backfillPollRecovered = true;
        streamOutcome = "backfilled_after_poll";
        linkedAbort.controller.abort(new Error(STREAM_BACKFILLED_MESSAGE));
      }
    })
    : null;
  watchdog.start();

  try {
    for await (const event of events) {
      watchdog.touch();
      const update = applyCodexStreamEvent(streamState, event);
      if (update.type === "thread_started") {
        if (options.rememberThreadId !== false) {
          const chat = getChatState(chatKey);
          chat.threadId = update.threadId;
          await saveState(config.stateFile, state);
          await recordThreadStarted(chatKey, update.threadId);
        }
      } else if (update.type === "item") {
        await recordStreamItemEvent(chatKey, event, update);
        if (!firstItemSeen) {
          firstItemSeen = true;
          await recordCodexStreamFirstItem(chatKey, event, update, Date.now() - streamStartedAt);
        }
        if (update.finalResponseChanged) {
          await recordCodexStreamFinalResponseSeen(chatKey, streamState.finalResponse.length, Date.now() - streamStartedAt);
        }
        const now = Date.now();
        if (workingMessageId && now - lastProgressAt > runtimeValue("progressEditIntervalMs")) {
          lastProgressAt = now;
          await editMessageQuietly(ctx, workingMessageId, summarizeProgress(codexStreamItems(streamState)));
        }
      } else if (update.type === "error") {
        streamOutcome = "error";
        await recordActiveTurnFailed(chatKey, update.message);
        throw new Error(update.message);
      } else if (update.type === "turn_completed") {
        await appendRecoveryEvent({ type: "turn_completed", chatKey });
      } else if (update.type === "unknown") {
        await recordCodexStreamUnknownEvent(chatKey, event, Date.now() - streamStartedAt);
      }
      await maybeSendLiveProgress(ctx, progressState, event, codexStreamItems(streamState));
    }

    return codexStreamResult(streamState);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (backfillPollRecovered || message === STREAM_BACKFILLED_MESSAGE) {
      streamOutcome = "backfilled_after_poll";
      return codexStreamResult(streamState);
    }
    streamOutcome = watchdog.timeoutTriggered ? STREAM_IDLE_TIMEOUT_MESSAGE : "error";
    if (watchdog.timeoutTriggered) {
      if (await tryBackfillCompletedStream(chatKey, thread, streamState, {
        sinceMs: streamStartedAt,
        reason: "stream_idle_timeout"
      })) {
        streamOutcome = "backfilled_after_idle_timeout";
        return codexStreamResult(streamState);
      }
      throw new Error(STREAM_IDLE_TIMEOUT_MESSAGE);
    }
    throw error;
  } finally {
    backfillPoller?.stop();
    watchdog.stop();
    linkedAbort.cleanup();
    await recordCodexStreamIteratorClosed(chatKey, {
      elapsedMs: Date.now() - streamStartedAt,
      outcome: streamOutcome,
      itemCount: codexStreamItems(streamState).length,
      finalResponseLength: streamState.finalResponse.length
    });
  }
}

function startCodexStreamBackfillPoller(chatKey, thread, streamState, { sinceMs = 0, intervalMs = 0, onRecovered = () => {} } = {}) {
  if (!config.botRestartRecoveryEnabled) return null;
  if (!Number.isFinite(Number(intervalMs)) || Number(intervalMs) <= 0) return null;
  return startRecoveryBackfillPoller({
    intervalMs,
    check: async () => {
      const backfillState = createCodexStreamState();
      const recovered = await tryBackfillCompletedStream(chatKey, thread, backfillState, {
        sinceMs,
        reason: "recovery_backfill_poll",
        recordMiss: false
      });
      if (recovered) copyCodexStreamState(streamState, backfillState);
      return recovered;
    },
    onRecovered,
    onError: (error, { reason } = {}) => appendRecoveryEvent({
      type: "recovery_backfill_poll_error",
      chatKey,
      threadId: thread?.id || getChatState(chatKey).threadId || "",
      reason: reason || "interval",
      message: truncate(error instanceof Error ? error.message : String(error), 500)
    })
  });
}

function copyCodexStreamState(target, source) {
  target.items = source.items;
  target.appServerAgentMessageTextById = source.appServerAgentMessageTextById;
  target.nextSyntheticItemId = source.nextSyntheticItemId;
  target.finalResponse = source.finalResponse;
  target.usage = source.usage;
}

async function tryBackfillCompletedStream(chatKey, thread, streamState, { sinceMs = 0, reason = "manual", recordMiss = true } = {}) {
  const threadId = thread?.id || getChatState(chatKey).threadId || "";
  if (!threadId) return false;
  let events = [];
  try {
    events = await readBackfillEventsForThread(thread, threadId, { sinceMs, reason });
  } catch (error) {
    await recordCodexStreamBackfill(chatKey, {
      threadId,
      reason,
      recovered: false,
      eventCount: 0,
      finalResponseLength: streamState.finalResponse.length,
      source: threadTransport(thread),
      status: error instanceof Error ? error.message : String(error)
    });
    return false;
  }
  if (events.length === 0) return false;

  let completed = false;
  let failed = false;
  for (const event of events) {
    const update = applyCodexStreamEvent(streamState, event);
    if (update.type === "turn_completed") completed = true;
    if (update.type === "error") failed = true;
  }
  const recovered = completed && !failed && Boolean(streamState.finalResponse);
  if (recovered || recordMiss) {
    await recordCodexStreamBackfill(chatKey, {
      threadId,
      reason,
      recovered,
      eventCount: events.length,
      finalResponseLength: streamState.finalResponse.length,
      source: threadTransport(thread)
    });
  }
  if (recovered) await appendRecoveryEvent({ type: "turn_completed", chatKey, threadId, source: "backfill" });
  return recovered;
}

async function readBackfillEventsForThread(thread, threadId, { sinceMs = 0 } = {}) {
  if (threadTransport(thread) === CODEX_TRANSPORT_APP_SERVER_DIRECT || codexTransport() === CODEX_TRANSPORT_APP_SERVER_DIRECT) {
    const response = await readAppServerThread({
      threadId,
      codexPath: config.codexPath,
      codexEnv: config.codexEnv,
      connectTimeoutMs: runtimeValue("codexAppServerDirectTimeoutMs"),
      includeTurns: true
    });
    return appServerThreadReadEvents(response, { threadId });
  }
  const backfill = await readCodexSessionBackfill({
    sessionsDir: config.codexSessionsDir,
    threadId,
    sinceMs
  });
  return backfill.events;
}

function createLinkedAbortController(parentSignal) {
  const controller = new AbortController();
  if (!parentSignal) return { controller, cleanup: () => {} };
  if (parentSignal.aborted) {
    controller.abort(parentSignal.reason);
    return { controller, cleanup: () => {} };
  }
  const abort = () => controller.abort(parentSignal.reason);
  parentSignal.addEventListener("abort", abort, { once: true });
  return {
    controller,
    cleanup: () => parentSignal.removeEventListener("abort", abort)
  };
}

async function refreshUsageSample(chatKey, signal) {
  const thread = startCodexThread(chatKey);
  await thread.run("Reply exactly: OK.", { signal });
  if (!thread.id) throw new Error("Usage refresh did not create a Codex thread id.");

  const sample = await waitForLatestTokenCount(thread.id);
  if (!sample) throw new Error("Codex usage sample was not written for the refresh turn.");

  const chat = getChatState(chatKey);
  chat.usageProbeThreadId = thread.id;
  chat.updatedAt = new Date().toISOString();
  await saveState(config.stateFile, state);
  return sample;
}

async function waitForLatestTokenCount(threadId) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const sample = await readLatestTokenCount(threadId);
    if (sample) return sample;
    await sleep(250);
  }
  return null;
}

async function maybeNotifyContextPressure(ctx, chatKey, thread) {
  if (!config.codexContextGuardEnabled) return;
  const threadId = thread?.id || getChatState(chatKey).threadId;
  if (!threadId) return;
  const sample = await readLatestTokenCount(threadId);
  const pressure = analyzeContextPressure(sample?.tokenCount);
  if (!pressure) return;

  const threshold = config.codexContextCompactThresholdPercent;
  const overPercent = threshold > 0 && pressure.percent >= threshold;
  const lowRemaining = config.codexContextMinRemainingTokens > 0
    && pressure.remainingTokens <= config.codexContextMinRemainingTokens;
  if (!overPercent && !lowRemaining) return;

  const autoLimit = resolveAutoCompactTokenLimit(config);
  await replyHtml(ctx, formatKeyValueHtml(t("contextCompactContinueTitle"), [
    [t("contextUsage"), `${Math.round(pressure.percent)}% (${pressure.inputTokens}/${pressure.modelContextWindow})`],
    [t("contextRemaining"), pressure.remainingTokens],
    [t("contextAutoCompact"), autoLimit > 0 ? autoLimit : t("contextAutoCompactDefault")],
    [t("contextAction"), t("contextCompactContinueAction")]
  ]));
}

async function recordActiveTurnStarted(chatKey, turn) {
  if (!config.botRestartRecoveryEnabled) return;
  const snapshot = {
    chatKey,
    chatId: turn.chatId ?? chatKey,
    messageThreadId: turn.messageThreadId,
    replyToMessageId: turn.replyToMessageId,
    originMessageId: turn.originMessageId,
    originUpdateId: turn.originUpdateId,
    queueItemId: turn.id || "",
    threadId: getChatState(chatKey).threadId || "",
    inputTextDigest: digestText(turn.inputText || turn.text || ""),
    inputPreview: truncate(String(turn.text || turn.inputText || "").replace(/\s+/g, " "), 240),
    workingDirectory: getEffectiveOptions(chatKey).workingDirectory || config.codexWorkdir,
    model: getEffectiveOptions(chatKey).model || config.codexModel || "",
    serviceTier: getEffectiveOptions(chatKey).serviceTier || "default",
    startedAt: new Date().toISOString(),
    lastEventAt: new Date().toISOString(),
    lastKnownStatus: "running",
    recoveryEligible: turn.kind !== "recovery",
    recoveryReason: turn.kind === "recovery" ? "recovery_turn" : ""
  };
  await safeRecoveryWrite(async () => {
    await replaceActiveTurnSnapshot(config.botRecoveryDir, chatKey, snapshot);
    await appendRecoveryEvent({ type: "turn_started", chatKey, queueItemId: turn.id || "", recoveryEligible: snapshot.recoveryEligible });
  });
}

async function recordThreadStarted(chatKey, threadId) {
  if (!config.botRestartRecoveryEnabled) return;
  await safeRecoveryWrite(async () => {
    await upsertActiveTurnSnapshot(config.botRecoveryDir, chatKey, {
      threadId,
      lastEventAt: new Date().toISOString(),
      lastKnownStatus: "thread_started"
    });
    await appendRecoveryEvent({ type: "thread_started", chatKey, threadId });
  });
}

async function recordStreamItemEvent(chatKey, event, update = {}) {
  if (!config.botRestartRecoveryEnabled) return;
  const summary = summarizeStreamEvent(event);
  const completed = update.eventType === "item.completed" || event.type === "item.completed";
  await safeRecoveryWrite(async () => {
    await upsertActiveTurnSnapshot(config.botRecoveryDir, chatKey, {
      lastEventAt: new Date().toISOString(),
      lastCompletedItemType: completed ? summary.itemType : undefined,
      lastCompletedItemId: completed ? summary.itemId : undefined,
      lastKnownStatus: summary.eventType || event.type || "unknown"
    });
    await appendRecoveryEvent({ type: "stream_item", chatKey, ...summary });
  });
}

async function recordCodexStreamStarted(chatKey, turnKind) {
  if (!config.botRestartRecoveryEnabled) return;
  await safeRecoveryWrite(async () => {
    await upsertActiveTurnSnapshot(config.botRecoveryDir, chatKey, {
      lastEventAt: new Date().toISOString(),
      lastKnownStatus: "codex_stream_started",
      streamTurnKind: turnKind || ""
    });
    await appendRecoveryEvent({ type: "codex_stream_started", chatKey, turnKind: turnKind || "" });
  });
}

async function recordCodexStreamFirstItem(chatKey, event, update, elapsedMs) {
  if (!config.botRestartRecoveryEnabled) return;
  const summary = summarizeStreamEvent(event);
  await safeRecoveryWrite(async () => {
    await upsertActiveTurnSnapshot(config.botRecoveryDir, chatKey, {
      lastEventAt: new Date().toISOString(),
      lastKnownStatus: "codex_stream_first_item",
      firstItemType: update.item?.type || summary.itemType || "",
      firstItemEventType: update.eventType || summary.eventType || event.type || ""
    });
    await appendRecoveryEvent({ type: "codex_stream_first_item", chatKey, elapsedMs, ...summary });
  });
}

async function recordCodexStreamFinalResponseSeen(chatKey, length, elapsedMs) {
  if (!config.botRestartRecoveryEnabled) return;
  await safeRecoveryWrite(async () => {
    await upsertActiveTurnSnapshot(config.botRecoveryDir, chatKey, {
      lastEventAt: new Date().toISOString(),
      lastKnownStatus: "codex_stream_final_response_seen",
      finalResponseLength: length,
      finalResponseSeenAt: new Date().toISOString()
    });
    await appendRecoveryEvent({ type: "codex_stream_final_response_seen", chatKey, elapsedMs, length });
  });
}

async function recordCodexStreamIteratorClosed(chatKey, metadata) {
  if (!config.botRestartRecoveryEnabled) return;
  await safeRecoveryWrite(async () => {
    await upsertActiveTurnSnapshot(config.botRecoveryDir, chatKey, {
      lastEventAt: new Date().toISOString(),
      lastKnownStatus: "codex_stream_iterator_closed",
      streamOutcome: metadata.outcome || ""
    });
    await appendRecoveryEvent({ type: "codex_stream_iterator_closed", chatKey, ...metadata });
  });
}

async function recordCodexStreamUnknownEvent(chatKey, event, elapsedMs) {
  if (!config.botRestartRecoveryEnabled) return;
  await safeRecoveryWrite(async () => {
    await appendRecoveryEvent({ type: "codex_stream_unknown_event", chatKey, elapsedMs, ...summarizeStreamEvent(event) });
  });
}

async function recordCodexStreamBackfill(chatKey, metadata) {
  if (!config.botRestartRecoveryEnabled) return;
  await safeRecoveryWrite(async () => {
    await upsertActiveTurnSnapshot(config.botRecoveryDir, chatKey, {
      lastEventAt: new Date().toISOString(),
      lastKnownStatus: metadata.recovered ? "codex_stream_backfilled" : "codex_stream_backfill_missed",
      backfillSource: metadata.source || "",
      backfillEventCount: metadata.eventCount ?? 0,
      backfillFinalResponseLength: metadata.finalResponseLength ?? 0
    });
    await appendRecoveryEvent({
      type: metadata.recovered ? "codex_stream_backfilled" : "codex_stream_backfill_missed",
      chatKey,
      ...metadata,
      status: truncate(metadata.status || "", 500)
    });
  });
}

async function recordStreamIdleNotice(ctx, chatKey, idleMs, isRecoveryTurn) {
  if (!config.botRestartRecoveryEnabled) return;
  await safeRecoveryWrite(async () => {
    await upsertActiveTurnSnapshot(config.botRecoveryDir, chatKey, {
      lastEventAt: new Date().toISOString(),
      lastKnownStatus: "stream_idle_notice",
      streamIdleMs: idleMs
    });
    await appendRecoveryEvent({ type: "stream_idle_notice", chatKey, idleMs, recovery: isRecoveryTurn });
  });
  if (isRecoveryTurn) {
    await replyHtml(ctx, `${b(t("recoveryIdleTitle"))}\n${t("recoveryIdleDetail")}`).catch(() => {});
  }
}

async function recordStreamIdleTimeout(chatKey, idleMs) {
  if (!config.botRestartRecoveryEnabled) return;
  await safeRecoveryWrite(async () => {
    await upsertActiveTurnSnapshot(config.botRecoveryDir, chatKey, {
      lastEventAt: new Date().toISOString(),
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
  if (!config.botRestartRecoveryEnabled) return;
  await safeRecoveryWrite(async () => {
    await upsertActiveTurnSnapshot(config.botRecoveryDir, chatKey, {
      lastEventAt: new Date().toISOString(),
      lastKnownStatus: "telegram_reply_ready",
      recoveryEligible: true,
      finalResponseDigest: metadata.digest,
      finalResponseLength: metadata.length
    });
    await appendRecoveryEvent({ type: "telegram_reply_ready", chatKey, jobId: execution.workerJobId || "", ...metadata });
  });
}

async function recordTelegramReplyStarted(chatKey, execution, text) {
  const metadata = telegramReplyMetadata(text);
  await transitionWorkerDelivery(chatKey, execution, (entry) => markWorkerDeliverySending(entry));
  if (!config.botRestartRecoveryEnabled) return;
  await safeRecoveryWrite(async () => {
    await upsertActiveTurnSnapshot(config.botRecoveryDir, chatKey, {
      lastEventAt: new Date().toISOString(),
      lastKnownStatus: "telegram_delivery_sending",
      recoveryEligible: true,
      finalResponseDigest: metadata.digest,
      finalResponseLength: metadata.length
    });
    await appendRecoveryEvent({ type: "telegram_reply_started", chatKey, jobId: execution.workerJobId || "", ...metadata });
  });
}

async function recordTelegramProgressFailed(progressState, event, errorSummary) {
  if (!config.botRestartRecoveryEnabled) return;
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
  if (!config.botRestartRecoveryEnabled) return;
  await safeRecoveryWrite(async () => {
    await appendRecoveryEvent({ type: "telegram_reply_completed", chatKey, jobId: execution.workerJobId || "", ...metadata });
  });
}

async function recordTelegramReplyFailed(chatKey, execution, error, { ambiguous = true } = {}) {
  const errorSummary = { ...summarizeTelegramError(error), ambiguous };
  await transitionWorkerDelivery(chatKey, execution, (entry) => markWorkerDeliveryFailed(entry, errorSummary));
  if (!config.botRestartRecoveryEnabled) return;
  await safeRecoveryWrite(async () => {
    await upsertActiveTurnSnapshot(config.botRecoveryDir, chatKey, {
      lastEventAt: new Date().toISOString(),
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

async function recordTelegramReplyDigestMismatch(chatKey, execution, expectedDigest, actualDigest) {
  await transitionWorkerDelivery(chatKey, execution, (entry) => markWorkerDeliveryFailed(entry, {
    kind: "integrity",
    code: "RESPONSE_DIGEST_MISMATCH",
    description: "Reconstructed response digest did not match the persisted result.",
    ambiguous: false
  }));
  if (!config.botRestartRecoveryEnabled) return;
  await safeRecoveryWrite(async () => {
    await upsertActiveTurnSnapshot(config.botRecoveryDir, chatKey, {
      lastEventAt: new Date().toISOString(),
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
  if (!state.worker.deliveries || typeof state.worker.deliveries !== "object") state.worker.deliveries = {};
  const key = workerDeliveryKey(chatKey, execution.workerJobId);
  const normalized = normalizeWorkerDeliveryEntry(key, state.worker.deliveries[key]);
  const current = normalized ?? markWorkerDeliveryStreaming(null, {
    chatKey,
    jobId: execution.workerJobId,
    seq: 0
  });
  const next = transition(current);
  state.worker.deliveries[key] = next;
  await saveState(config.stateFile, state);
  return next;
}

function telegramReplyMetadata(text) {
  return {
    digest: digestText(text),
    length: String(text || "").length
  };
}

async function restoreRecoveryThreadForTurn(chatKey, turn) {
  const recoveryThreadId = String(turn?.recovery?.threadId || "").trim();
  if (!recoveryThreadId) return;
  const chat = getChatState(chatKey);
  const changed = applyRecoveryThreadToChatState(chat, turn);
  const cached = threadCache.get(chatKey);
  if (cached && cached.id !== recoveryThreadId) threadCache.delete(chatKey);
  if (!changed) return;
  await saveState(config.stateFile, state);
  await appendRecoveryEvent({
    type: "recovery_thread_restored",
    chatKey,
    threadId: recoveryThreadId,
    recoveryKey: turn.recovery?.recoveryKey || ""
  });
}

async function recordActiveTurnCompleted(chatKey, threadId) {
  if (!config.botRestartRecoveryEnabled) return;
  await safeRecoveryWrite(async () => {
    await appendRecoveryEvent({ type: "turn_completed", chatKey, threadId });
    await removeActiveTurnSnapshot(config.botRecoveryDir, chatKey);
    const active = activeTurns.get(chatKey);
    if (active?.currentPreparedTurn?.kind === "recovery") {
      await markRecoveryAttempt(config.botRecoveryDir, active.currentPreparedTurn.recovery || { chatKey, threadId }, { status: "completed" });
      await clearCompletedRecovery(config.botRecoveryDir);
    }
  });
}

async function recordActiveTurnFailed(chatKey, message) {
  if (!config.botRestartRecoveryEnabled) return;
  await safeRecoveryWrite(async () => {
    await upsertActiveTurnSnapshot(config.botRecoveryDir, chatKey, {
      lastEventAt: new Date().toISOString(),
      lastKnownStatus: "failed",
      recoveryEligible: false,
      recoveryReason: message
    });
    await appendRecoveryEvent({ type: "turn_failed", chatKey, message: truncate(message, 500) });
    const active = activeTurns.get(chatKey);
    if (active?.currentPreparedTurn?.kind === "recovery") {
      await markRecoveryAttempt(config.botRecoveryDir, active.currentPreparedTurn.recovery || { chatKey }, { status: "failed" });
    }
  });
}

async function markActiveTurnStopped(chatKey) {
  if (!config.botRestartRecoveryEnabled) return;
  await safeRecoveryWrite(async () => {
    await upsertActiveTurnSnapshot(config.botRecoveryDir, chatKey, {
      lastEventAt: new Date().toISOString(),
      lastKnownStatus: "stopped",
      recoveryEligible: false,
      recoveryReason: "user_stop"
    });
    await appendRecoveryEvent({ type: "turn_stopped", chatKey });
  });
}

async function appendRecoveryEvent(event) {
  await appendRecoveryJournal(config.botRecoveryDir, event);
}

async function safeRecoveryWrite(fn) {
  try {
    await ensureRecoveryDir(config.botRecoveryDir);
    await fn();
  } catch (error) {
    console.warn("recovery journal write failed:", error instanceof Error ? error.message : String(error));
  }
}

function digestText(text) {
  return `sha256:${createHash("sha256").update(String(text)).digest("hex")}`;
}

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

function defaultChatOptions() {
  const options = {
    workingDirectory: config.codexWorkdir,
    skipGitRepoCheck: config.codexSkipGitRepoCheck,
    approvalPolicy: config.codexApprovalPolicy,
    sandboxMode: config.codexSandboxMode,
    modelReasoningEffort: config.codexReasoningEffort,
    webSearchMode: config.codexWebSearch,
    streamEvents: true,
    liveProgressEnabled: runtimeValue("telegramLiveProgressEnabled"),
    liveProgressSource: config.telegramLiveProgressSource,
    liveProgressDeletePolicy: config.telegramLiveProgressDeletePolicy
  };
  if (config.codexModel) options.model = config.codexModel;
  if (typeof config.codexNetworkAccess === "boolean") options.networkAccessEnabled = config.codexNetworkAccess;
  if (typeof config.codexWebSearchEnabled === "boolean") options.webSearchEnabled = config.codexWebSearchEnabled;
  const additionalDirectories = mergeAdditionalDirectories(config.codexAdditionalDirectories, config.uploadDir);
  if (additionalDirectories.length > 0) options.additionalDirectories = additionalDirectories;
  return options;
}

function buildTurnOptions(chatKey, signal) {
  const chat = getChatState(chatKey);
  const options = { signal };
  if (chat.outputSchema) options.outputSchema = chat.outputSchema;
  return options;
}

function getEffectiveOptions(chatKey) {
  return { ...defaultChatOptions(), ...getChatState(chatKey).options };
}

function effectiveModelSlug(chatKey) {
  return state.chats[chatKey]?.options?.model ?? config.codexModel ?? "";
}

function planRuntimeModelReasoningTransition(
  models,
  modelSlug,
  explicitReasoning,
  allowExplicitClear = false
) {
  return planModelReasoningTransition({
    models,
    modelSlug,
    explicitReasoning,
    configuredReasoning: config.codexReasoningEffort,
    allowExplicitClear
  });
}

function getChatState(chatKey) {
  if (!state.chats[chatKey]) {
    state.chats[chatKey] = { options: {}, updatedAt: new Date().toISOString() };
  }
  if (!state.chats[chatKey].options) state.chats[chatKey].options = {};
  return state.chats[chatKey];
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

async function updateOptionCommand(ctx, key, usage) {
  const chatKey = getChatKey(ctx);
  if (await rejectIfActive(ctx, chatKey)) return;
  const value = getCommandArgs(ctx).trim();
  if (!value) {
    await replyHtml(ctx, `Usage: ${code(`/${commandName(ctx)} <${usage}>`)}`);
    return;
  }
  await updateOptionValue(ctx, key, value);
}

async function updateOptionValue(ctx, key, value) {
  const chatKey = getChatKey(ctx);
  if (await rejectIfActive(ctx, chatKey)) return;
  try {
    await setOption(chatKey, key, value);
  } catch (error) {
    await replyHtml(ctx, code(error instanceof Error ? error.message : String(error)));
    return;
  }
  await saveState(config.stateFile, state);
  await replyHtml(ctx, `${b(`Updated ${key}.`)}\n\n${formatOptionsHtml(chatKey)}`);
}

async function setOption(chatKey, key, rawValue) {
  const value = rawValue.trim();
  const lower = value.toLowerCase();
  const clearsOption = lower === "off" || lower === "default" || lower === "clear";
  let modelCatalog = null;
  let transition = { action: "keep" };
  if (key === "model") {
    modelCatalog = await listCodexModels();
    const prospectiveModel = clearsOption ? config.codexModel ?? "" : value;
    transition = planRuntimeModelReasoningTransition(
      modelCatalog,
      prospectiveModel,
      state.chats[chatKey]?.options?.modelReasoningEffort,
      true
    );
    if (transition.action === "reject") {
      const supported = reasoningOptionsForModel(modelCatalog, prospectiveModel)
        .map(({ effort }) => effort)
        .join(", ") || "none";
      throw new Error(`reasoning for ${prospectiveModel || "default"} must be one of: ${supported}`);
    }
  } else if (key === "modelReasoningEffort" && clearsOption) {
    modelCatalog = await listCodexModels();
    const model = effectiveModelSlug(chatKey);
    transition = planRuntimeModelReasoningTransition(modelCatalog, model, undefined);
    if (transition.action === "reject") {
      const supported = reasoningOptionsForModel(modelCatalog, model)
        .map(({ effort }) => effort)
        .join(", ") || "none";
      throw new Error(`reasoning for ${model || "default"} must be one of: ${supported}`);
    }
  }

  if (clearsOption) {
    const chat = getChatState(chatKey);
    delete chat.options[key];
    if (transition.action === "clear") delete chat.options.modelReasoningEffort;
    invalidateThreadCache(chatKey);
    return;
  }

  if (key === "modelReasoningEffort") {
    const models = await listCodexModels();
    const model = effectiveModelSlug(chatKey);
    if (!isReasoningEffortSupported(models, model, lower)) {
      const supported = reasoningOptionsForModel(models, model).map(({ effort }) => effort).join(", ") || "none";
      throw new Error(`reasoning for ${model || "default"} must be one of: ${supported}`);
    }
  }

  const chat = getChatState(chatKey);
  if (key === "model") {
    chat.options.model = value;
    if (transition.action === "clear") delete chat.options.modelReasoningEffort;
  } else if (key === "workingDirectory") {
    await ensureDirectory(value, "working directory");
    chat.options.workingDirectory = value;
  } else if (key === "sandboxMode") {
    assertEnum(value, VALID.sandbox, "sandbox");
    chat.options.sandboxMode = value;
  } else if (key === "approvalPolicy") {
    assertEnum(value, VALID.approval, "approval");
    chat.options.approvalPolicy = value;
  } else if (key === "modelReasoningEffort") {
    chat.options.modelReasoningEffort = lower;
  } else if (key === "webSearchMode") {
    assertEnum(value, VALID.webSearch, "websearch");
    chat.options.webSearchMode = value;
  } else if (key === "serviceTier") {
    assertEnum(value, VALID.serviceTier, "service tier");
    chat.options.serviceTier = value;
  } else if (key === "liveProgressSource") {
    assertEnum(value, VALID.liveProgressSource, "live progress source");
    chat.options.liveProgressSource = value;
  } else if (key === "liveProgressDeletePolicy") {
    assertEnum(value, VALID.liveProgressDeletePolicy, "live progress delete policy");
    chat.options.liveProgressDeletePolicy = value;
  } else if (key === "networkAccessEnabled" || key === "skipGitRepoCheck" || key === "streamEvents" || key === "liveProgressEnabled") {
    chat.options[key] = parseRequiredBoolean(value, key);
  } else {
    throw new Error(`Unknown option: ${key}`);
  }
  invalidateThreadCache(chatKey);
}

function invalidateThreadCache(chatKey) {
  threadCache.delete(chatKey);
  getChatState(chatKey).updatedAt = new Date().toISOString();
}

async function rejectIfActive(ctx, chatKey) {
  if (!activeTurns.has(chatKey)) return false;
  await replyHtml(ctx, `Codex turn is already running. Use ${code("/stop")} first. Plain messages can still be queued.`);
  return true;
}

function getPendingTurns(chatKey) {
  return pendingTurns.get(chatKey) ?? [];
}

async function enqueuePendingTurn(chatKey, preparedTurn) {
  const queue = getPendingTurns(chatKey);
  const result = enqueueTurn(queue, preparedTurn, { max: runtimeValue("telegramPendingTurnsMax") });
  if (!result.ok) return { ok: false, position: queue.length };
  pendingTurns.set(chatKey, result.queue);
  await persistPendingTurns(chatKey);
  return { ok: true, position: result.position };
}

async function enqueuePendingTurnFront(chatKey, preparedTurn) {
  const queue = getPendingTurns(chatKey);
  const result = enqueueTurn(queue, preparedTurn, { max: runtimeValue("telegramPendingTurnsMax"), front: true });
  if (!result.ok) return { ok: false, position: queue.length };
  pendingTurns.set(chatKey, result.queue);
  await persistPendingTurns(chatKey);
  return { ok: true, position: result.position };
}

async function dequeuePendingTurn(chatKey, ctx = null) {
  const result = dequeueNextTurn(getPendingTurns(chatKey), queueExpiryOptions());
  if (result.queue.length > 0) pendingTurns.set(chatKey, result.queue);
  else pendingTurns.delete(chatKey);
  await persistPendingTurns(chatKey);
  if (result.expired > 0 && ctx) await notifyExpiredPendingTurns(ctx, result.expired);
  return result.turn;
}

async function clearPendingTurns(chatKey) {
  const count = getPendingTurns(chatKey).length;
  pendingTurns.delete(chatKey);
  await persistPendingTurns(chatKey);
  return count;
}

async function clearRecoveryPendingTurns() {
  let cleared = 0;
  for (const [chatKey, queue] of [...pendingTurns.entries()]) {
    const result = removeRecoveryTurns(queue);
    if (result.changed === 0) continue;
    cleared += result.changed;
    if (result.queue.length > 0) pendingTurns.set(chatKey, result.queue);
    else pendingTurns.delete(chatKey);
    await persistPendingTurns(chatKey);
  }
  return cleared;
}

async function removePendingTurn(chatKey, selector) {
  const result = removeTurn(getPendingTurns(chatKey), selector);
  if (result.changed === 0) return 0;
  if (result.queue.length > 0) pendingTurns.set(chatKey, result.queue);
  else pendingTurns.delete(chatKey);
  await persistPendingTurns(chatKey);
  return result.changed;
}

async function movePendingTurn(chatKey, turnId, direction) {
  const result = moveTurn(getPendingTurns(chatKey), turnId, direction);
  if (result.changed === 0) return 0;
  pendingTurns.set(chatKey, result.queue);
  await persistPendingTurns(chatKey);
  return result.changed;
}

function countPendingTurns() {
  let count = 0;
  for (const queue of pendingTurns.values()) count += queue.length;
  return count;
}

function hydratePendingTurnsFromState() {
  const hydrated = hydratePendingQueues(state.queues, {
    ...queueExpiryOptions(),
    createId: createQueueItemId
  });
  pendingTurns.clear();
  for (const [chatKey, queue] of hydrated.pending.entries()) pendingTurns.set(chatKey, queue);
  state.queues = hydrated.queues;
}

async function persistPendingTurns(chatKey) {
  const queue = getPendingTurns(chatKey).map(serializePendingTurn);
  if (queue.length > 0) state.queues[chatKey] = queue;
  else delete state.queues[chatKey];
  await saveState(config.stateFile, state);
}

async function pruneExpiredPendingTurns(chatKey, ctx = null) {
  const result = pruneExpiredTurns(getPendingTurns(chatKey), queueExpiryOptions());
  if (result.expired === 0) return 0;
  if (result.queue.length > 0) pendingTurns.set(chatKey, result.queue);
  else pendingTurns.delete(chatKey);
  await persistPendingTurns(chatKey);
  if (ctx) await notifyExpiredPendingTurns(ctx, result.expired);
  return result.expired;
}

function queueExpiryOptions() {
  return { maxAgeSeconds: runtimeValue("telegramPendingTurnMaxAgeSeconds") };
}

async function notifyExpiredPendingTurns(ctx, count) {
  await replyHtml(ctx, tf("expiredQueuedTurnsCleaned", { count: code(cleanupCount(count)) }));
}

function createQueueItemId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function isQueuePaused(chatKey) {
  return getChatState(chatKey).queuePaused === true;
}

function hasPendingFinalDelivery(chatKey) {
  return hasPendingWorkerDelivery(state.worker?.deliveries, chatKey);
}

function getQueueMode(chatKey) {
  const mode = getChatState(chatKey).queueMode;
  return VALID.queueMode.has(mode) ? mode : "safe";
}

async function setQueuePaused(chatKey, paused) {
  const chat = getChatState(chatKey);
  chat.queuePaused = paused;
  chat.updatedAt = new Date().toISOString();
  await saveState(config.stateFile, state);
}

async function setQueueMode(chatKey, mode) {
  const chat = getChatState(chatKey);
  chat.queueMode = mode;
  chat.updatedAt = new Date().toISOString();
  await saveState(config.stateFile, state);
}

function trackSideTurn(chatKey, abortController) {
  const controllers = sideTurns.get(chatKey) ?? new Set();
  controllers.add(abortController);
  sideTurns.set(chatKey, controllers);
}

function untrackSideTurn(chatKey, abortController) {
  const controllers = sideTurns.get(chatKey);
  if (!controllers) return;
  controllers.delete(abortController);
  if (controllers.size === 0) sideTurns.delete(chatKey);
}

function stopSideTurns(chatKey) {
  const controllers = sideTurns.get(chatKey);
  if (!controllers) return 0;
  const count = controllers.size;
  for (const controller of controllers) controller.abort();
  return count;
}

function getSideTurnCount(chatKey) {
  return sideTurns.get(chatKey)?.size ?? 0;
}

function isRecoveryActive(chatKey) {
  return activeTurns.get(chatKey)?.currentPreparedTurn?.kind === "recovery";
}

function countSideTurns() {
  let count = 0;
  for (const controllers of sideTurns.values()) count += controllers.size;
  return count;
}

async function startQueueDrainIfIdle(chatKey, ctx = null) {
  if (activeTurns.has(chatKey) || hasPendingFinalDelivery(chatKey) || isQueuePaused(chatKey)) return false;
  const runCtx = ctx ?? createSyntheticCtx(chatKey);
  const firstTurn = await dequeuePendingTurn(chatKey, runCtx);
  if (!firstTurn) return false;

  const active = { abortController: null, stopRequested: false };
  activeTurns.set(chatKey, active);
  runPreparedTurnQueue(chatKey, firstTurn, active).catch(async (error) => {
    activeTurns.delete(chatKey);
    await replyHtml(runCtx, `<b>Queued Codex turn failed</b>\n${code(error instanceof Error ? error.message : String(error))}`).catch(() => {});
  });
  return true;
}

function startPersistedQueues() {
  setTimeout(() => {
    for (const chatKey of pendingTurns.keys()) {
      startQueueDrainIfIdle(chatKey).catch((error) => {
        console.warn("persisted queue start failed:", error instanceof Error ? error.message : String(error));
      });
    }
  }, 3000);
}

function telegramNotifyExtra(meta = {}) {
  return telegramReplyExtraFromMeta(meta);
}

function createSyntheticCtx(turnOrChatKey) {
  const meta = typeof turnOrChatKey === "object" && turnOrChatKey
    ? turnOrChatKey
    : { chatKey: String(turnOrChatKey), chatId: turnOrChatKey };
  const rawChatId = meta.chatId ?? meta.chatKey;
  const chatId = Number.isNaN(Number(rawChatId)) ? rawChatId : Number(rawChatId);
  const message = telegramSyntheticMessageFromMeta(meta);
  return {
    chat: { id: chatId, type: meta.chatType },
    from: { id: chatId },
    message,
    msg: message,
    telegram: bot.telegram,
    reply: (text, extra = {}) => bot.telegram.sendMessage(chatId, text, telegramReplyExtraFromMeta(meta, extra)),
    sendChatAction: (action) => bot.telegram.sendChatAction(chatId, action, telegramChatActionExtraFromMeta(meta))
  };
}

function ensureTurnContext(turn) {
  if (turn.ctx) return turn.ctx;
  turn.ctx = createSyntheticCtx(turn);
  return turn.ctx;
}

function telegramMessageMeta(ctx) {
  const message = ctx.message ?? ctx.msg ?? {};
  return {
    chatType: ctx.chat?.type,
    messageThreadId: normalizeTelegramId(message.message_thread_id),
    replyToMessageId: normalizeTelegramId(message.reply_to_message?.message_id),
    originMessageId: normalizeTelegramId(message.message_id),
    originUpdateId: normalizeTelegramId(ctx.update?.update_id)
  };
}

async function buildReplyContext(ctx) {
  const message = ctx.message?.reply_to_message;
  if (!message) return { text: "", imagePaths: [] };

  const parts = [];
  const author = message.from?.username ? `@${message.from.username}` : message.from?.first_name || "unknown";
  const body = message.text || message.caption || "";
  parts.push(`Replied-to Telegram message from ${author}:`);
  if (body) parts.push(body);
  else parts.push("[no text or caption]");

  const imagePaths = [];
  const photo = message.photo?.at(-1);
  if (photo) imagePaths.push(await downloadTelegramFile(ctx, photo.file_id, ".jpg"));
  const document = message.document;
  if (isPdfDocument(document)) {
    const record = await downloadTelegramPdf(ctx, document, message);
    parts.push("[attached replied-to PDF file]");
    parts.push(formatPdfReferenceText(record));
  } else if (document?.mime_type?.startsWith("image/")) {
    const ext = path.extname(document.file_name ?? "") || extensionFromMime(document.mime_type);
    imagePaths.push(await downloadTelegramFile(ctx, document.file_id, ext));
  }

  if (imagePaths.length > 0) parts.push(`[attached ${imagePaths.length} replied-to image(s)]`);
  return { text: parts.join("\n"), imagePaths };
}

function applyPersonaPrompt(text) {
  const personaPrompt = effectivePersonaPrompt();
  if (!personaPrompt) return text;
  return [
    "<style_instruction>",
    personaPrompt,
    "</style_instruction>",
    "",
    text
  ].join("\n");
}

function effectivePersonaPrompt() {
  return buildStyleInstructionPrompt({
    language: uiLanguage(),
    personaPrompt: config.codexPersonaPrompt
  });
}

async function downloadTelegramFileRecord(ctx, fileId, ext) {
  const link = await ctx.telegram.getFileLink(fileId);
  const response = await fetch(link.href);
  if (!response.ok) throw new Error(`Telegram file download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (config.uploadMaxBytes > 0 && bytes.length > config.uploadMaxBytes) {
    throw new Error(`Telegram file exceeds UPLOAD_MAX_BYTES (${formatBytes(bytes.length)} > ${formatBytes(config.uploadMaxBytes)}).`);
  }
  await ensurePrivateDirectory(config.uploadDir);
  const filename = `${Date.now()}-${fileId.replace(/[^a-zA-Z0-9_-]/g, "")}${ext}`;
  const filePath = path.join(config.uploadDir, filename);
  await writePrivateFile(filePath, bytes);
  return { path: filePath, bytes: bytes.length };
}

async function downloadTelegramFile(ctx, fileId, ext) {
  const record = await downloadTelegramFileRecord(ctx, fileId, ext);
  return record.path;
}

async function downloadTelegramPdf(ctx, document, sourceMessage) {
  const downloaded = await downloadTelegramFileRecord(ctx, document.file_id, ".pdf");
  return createUploadedPdfRecord(document, downloaded, {
    messageId: normalizeTelegramId(sourceMessage?.message_id)
  });
}

async function rememberLastPdfUpload(ctx, record) {
  const chat = getChatState(getChatKey(ctx));
  chat.lastPdfUpload = record;
  chat.updatedAt = new Date().toISOString();
  await saveState(config.stateFile, state);
}

function getFreshLastPdfUpload(chatKey) {
  const record = getChatState(chatKey).lastPdfUpload;
  return isFreshPdfUpload(record) ? record : null;
}

function formatUploadedPdfUploadHtml(record) {
  return formatUploadedPdfHtml(record, {
    title: t("pdfUploadedTitle"),
    detail: t("pdfUploadedDetail"),
    labels: {
      file: t("pdfUploadedFile"),
      size: t("pdfUploadedSize"),
      path: t("pdfUploadedPath")
    },
    formatBytes
  });
}

function extensionFromMime(mime) {
  if (mime === "image/png") return ".png";
  if (mime === "image/webp") return ".webp";
  if (mime === "image/gif") return ".gif";
  return ".jpg";
}

function getChatKey(ctx) {
  return String(ctx.chat?.id ?? ctx.from?.id);
}

function commandName(ctx) {
  return (ctx.message?.text ?? "").trimStart().split(/\s+/, 1)[0]?.replace(/^\//, "") || "command";
}

function getCommandArgs(ctx) {
  const text = ctx.message?.text ?? "";
  const commandLength = text.trimStart().split(/\s+/, 1)[0]?.length ?? 0;
  return text.trimStart().slice(commandLength).trim();
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

async function loadState(file) {
  try {
    const data = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(data);
    return normalizeState(parsed);
  } catch (error) {
    if (error?.code === "ENOENT") return normalizeState({});
    throw error;
  }
}

function normalizeState(parsed) {
  const stateValue = parsed && typeof parsed === "object" ? parsed : {};
  return {
    ...stateValue,
    ui: {
      language: parseLanguage(stateValue.ui?.language || config.telegramLanguage),
      timeZone: parseTimeZone(stateValue.ui?.timeZone || config.telegramTimeZone),
      locale: parseLocale(stateValue.ui?.locale || config.telegramLocale)
    },
    runtime: stateValue.runtime && typeof stateValue.runtime === "object" ? sanitizeRuntimeSettings(stateValue.runtime) : {},
    chats: stateValue.chats && typeof stateValue.chats === "object" ? stateValue.chats : {},
    queues: stateValue.queues && typeof stateValue.queues === "object" ? stateValue.queues : {},
    cleanup: {
      lastDailyDate: stateValue.cleanup?.lastDailyDate ?? "",
      plans: stateValue.cleanup?.plans && typeof stateValue.cleanup.plans === "object" ? stateValue.cleanup.plans : {}
    },
    uploadCleanup: {
      plans: stateValue.uploadCleanup?.plans && typeof stateValue.uploadCleanup.plans === "object" ? stateValue.uploadCleanup.plans : {}
    },
    maintenance: {
      autoSqliteRepairEnabled: typeof stateValue.maintenance?.autoSqliteRepairEnabled === "boolean"
        ? stateValue.maintenance.autoSqliteRepairEnabled
        : config.codexMaintenanceAutoSqliteRepairEnabled,
      autoHandoffEnabled: typeof stateValue.maintenance?.autoHandoffEnabled === "boolean"
        ? stateValue.maintenance.autoHandoffEnabled
        : config.codexMaintenanceAutoHandoffEnabled
    },
    worker: {
      deliveries: stateValue.worker?.deliveries && typeof stateValue.worker.deliveries === "object"
        ? stateValue.worker.deliveries
        : {}
    },
    snapshots: {
      lastDailyDate: stateValue.snapshots?.lastDailyDate ?? ""
    }
  };
}

function sanitizeRuntimeSettings(value) {
  const sanitized = {};
  for (const [key, raw] of Object.entries(value || {})) {
    try {
      setRuntimeValue(sanitized, key, raw);
    } catch {
      // Ignore stale or invalid runtime overrides from older state files.
    }
  }
  return sanitized;
}

function runtimeValue(key) {
  return state.runtime?.[key] ?? config[key];
}

function runtimeSeconds(key) {
  return Math.round(Number(runtimeValue(key) || 0) / 1000);
}

function setRuntimeValue(target, key, rawValue) {
  if (rawValue == null || rawValue === "default") {
    delete target[key];
    return;
  }
  const value = String(rawValue).trim();
  if (key === "telegramReactionsEnabled" || key === "telegramLiveProgressEnabled" || key === "cleanupEnabled" || key === "snapshotEnabled") {
    target[key] = parseRequiredBoolean(value, key);
  } else if (key === "telegramFormatCodexAnswers") {
    target[key] = parseCodexAnswerFormat(value);
  } else if (key === "codexTransport") {
    if (!VALID.codexTransport.has(value)) throw new Error("codexTransport must be sdk or app-server-direct.");
    target[key] = value;
  } else if (key === "codexWorkerMode") {
    if (!VALID.codexWorkerMode.has(value)) throw new Error("codexWorkerMode must be sidecar or inline.");
    target[key] = value;
  } else if (key === "telegramLiveProgressMode") {
    if (!["brief", "korean-brief"].includes(value)) throw new Error("telegramLiveProgressMode must be brief or korean-brief.");
    target[key] = value;
  } else if (key === "cleanupNotifyTime" || key === "snapshotNotifyTime") {
    target[key] = parseTimeOfDay(value);
  } else if (key === "telegramCompletionNoticeSeconds" || key === "telegramPendingTurnsMax" || key === "telegramPendingTurnMaxAgeSeconds" || key === "cleanupRetentionDays" || key === "cleanupQuarantineDays" || key === "cleanupPlanTtlHours" || key === "snapshotRetentionDays" || key === "logsMaxLines" || key === "maxTelegramChars" || key === "codexAppServerDirectTimeoutMs" || key === "codexWorkerConnectTimeoutMs" || key === "codexWorkerEventPollMs") {
    target[key] = parseStrictNonnegativeInteger(value, key);
  } else if (key === "telegramLiveProgressIntervalMs" || key === "progressEditIntervalMs") {
    const parsed = parseStrictNonnegativeInteger(value, key);
    target[key] = parsed >= 1000 ? parsed : parsed * 1000;
  } else {
    throw new Error(`Unknown runtime setting: ${key}`);
  }
}

async function updateRuntimeSetting(key, rawValue) {
  if (!state.runtime || typeof state.runtime !== "object") state.runtime = {};
  const previousTransport = codexTransport();
  const previousWorkerMode = codexWorkerMode();
  const value = String(rawValue || "").replaceAll("_", ":");
  setRuntimeValue(state.runtime, key, value);
  if (key === "codexTransport" && codexTransport() !== previousTransport) threadCache.clear();
  if (key === "codexWorkerMode" && codexWorkerMode() !== previousWorkerMode) threadCache.clear();
  await saveState(config.stateFile, state);
}

function parseStrictNonnegativeInteger(value, label) {
  const parsed = Number(String(value ?? "").trim());
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative integer.`);
  return parsed;
}

function parseTimeOfDay(value) {
  const normalized = String(value || "").trim().replaceAll("_", ":");
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(normalized)) throw new Error("Time must use HH:MM.");
  return normalized;
}

async function saveState(file, value) {
  await writePrivateFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
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

async function editCleanupMessage(ctx, html) {
  return editOrReplyHtml(ctx, html, { reply_markup: { inline_keyboard: [] } });
}

async function editUploadCleanupMessage(ctx, html) {
  return editOrReplyHtml(ctx, html, { reply_markup: { inline_keyboard: [] } });
}

async function editCleanupProcessingMessage(ctx, action, plan) {
  return editOrReplyHtml(ctx, formatCleanupProcessingHtml(action, plan), {
    reply_markup: {
      inline_keyboard: [[{ text: t("cleanupProcessingButton"), callback_data: `cleanup:processing:${plan.id}` }]]
    }
  });
}

function cleanupActionLabel(action) {
  if (action === "quarantine") return t("cleanupActionQuarantine");
  if (action === "delete") return t("cleanupActionDelete");
  if (action === "both") return t("cleanupActionBoth");
  if (action === "ignore") return t("cleanupActionIgnore");
  return action;
}

function cleanupCallbackText(action) {
  if (action === "quarantine") return t("cleanupCallbackQuarantine");
  if (action === "delete") return t("cleanupCallbackDelete");
  if (action === "both") return t("cleanupCallbackBoth");
  if (action === "ignore") return t("cleanupCallbackIgnore");
  if (action === "missing") return t("cleanupCallbackMissing");
  if (action === "expired") return t("cleanupCallbackExpired");
  return "";
}

async function answerCleanupCallback(ctx, action) {
  try {
    await ctx.answerCbQuery(cleanupCallbackText(action));
  } catch (error) {
    console.warn("cleanup callback answer failed:", summarizeTelegramError(error));
  }
}

async function answerUploadCleanupCallback(ctx, status) {
  const text = status === "confirm"
    ? "Deleting selected upload cleanup candidates..."
    : status === "expired_plan"
      ? "Upload cleanup plan expired."
      : status === "processing"
        ? "Upload cleanup is already processing."
        : "Upload cleanup plan not found.";
  try {
    await ctx.answerCbQuery(text);
  } catch (error) {
    console.warn("upload cleanup callback answer failed:", summarizeTelegramError(error));
  }
}

function formatCleanupProcessingHtml(action, plan) {
  const lines = [
    b(tf("cleanupProcessingTitle", { action: cleanupActionLabel(action) })),
    "",
    t("cleanupProcessingBody"),
    "",
    b(t("cleanupTargets")),
    `- ${t("cleanupQuarantineCandidates")}: ${code(cleanupCount(plan.quarantineCandidates.length))}`,
    `- ${t("cleanupPermanentDeleteCandidates")}: ${code(cleanupCount(plan.deleteCandidates.length))}`,
    "",
    t("cleanupFinishReplace")
  ];
  return lines.join("\n");
}

function formatCleanupIgnoredHtml(plan) {
  return [
    b(t("cleanupIgnoredTitle")),
    "",
    `${t("cleanupQuarantineCandidates")}: ${code(cleanupCount(plan.quarantineCandidates.length))}`,
    `${t("cleanupPermanentDeleteCandidates")}: ${code(cleanupCount(plan.deleteCandidates.length))}`,
    "",
    t("cleanupNoFilesMoved")
  ].join("\n");
}

function formatCleanupResultHtml(action, result, plan = null) {
  const lines = [
    b(tf("cleanupResultTitle", { action: cleanupActionLabel(action) })),
    "",
    `${t("cleanupResultQuarantined")}: ${code(result.quarantined)}`,
    `${t("cleanupResultDeleted")}: ${code(result.deleted)}`,
    `${t("cleanupResultSkipped")}: ${code(result.skipped)}`,
    `${t("cleanupResultErrors")}: ${code(result.errors.length)}`,
    `manifest: ${code(result.manifest || "none")}`,
    `restore: ${code(result.restoreScript || "none")}`
  ];
  if (plan) {
    lines.push(
      "",
      b(t("cleanupTargetSummary")),
      `- ${t("cleanupQuarantineCandidates")}: ${code(cleanupCount(plan.quarantineCandidates.length))}`,
      `- ${t("cleanupPermanentDeleteCandidates")}: ${code(cleanupCount(plan.deleteCandidates.length))}`
    );
  }
  if (result.errors.length > 0) {
    lines.push("", ...result.errors.slice(0, 3).map((error) => `- ${code(error)}`));
  }
  return lines.join("\n");
}
async function listCleanupSessionFiles(protectedThreadIds) {
  let files = [];
  try {
    files = await listFiles(config.codexSessionsDir);
  } catch (error) {
    if (error?.code === "ENOENT") return { protectedCount: protectedThreadIds.size, recentCount: 0, candidates: [] };
    throw error;
  }

  const cutoff = Date.now() - runtimeValue("cleanupRetentionDays") * 24 * 60 * 60 * 1000;
  const candidates = [];
  let recentCount = 0;

  for (const file of files.filter((entry) => entry.endsWith(".jsonl"))) {
    const meta = await readSessionMeta(file);
    if (!meta?.id) continue;
    const stat = await fs.stat(file);
    if (protectedThreadIds.has(meta.id)) continue;
    if (stat.mtimeMs >= cutoff) {
      recentCount += 1;
      continue;
    }
    candidates.push({
      threadId: meta.id,
      path: file,
      modifiedAt: stat.mtime.toISOString(),
      ageDays: Math.floor((Date.now() - stat.mtimeMs) / 86_400_000),
      bytes: stat.size
    });
  }

  candidates.sort((left, right) => left.modifiedAt.localeCompare(right.modifiedAt));
  return { protectedCount: protectedThreadIds.size, recentCount, candidates };
}

async function listQuarantineDeleteCandidates() {
  let files = [];
  try {
    files = await listFiles(config.cleanupQuarantineDir);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  const cutoff = Date.now() - runtimeValue("cleanupQuarantineDays") * 24 * 60 * 60 * 1000;
  const candidates = [];
  for (const file of files.filter((entry) => entry.endsWith(".jsonl"))) {
    const stat = await fs.stat(file);
    const metadata = await readCleanupMetadata(file);
    const quarantinedAt = metadata?.quarantinedAt ? Date.parse(metadata.quarantinedAt) : stat.mtimeMs;
    if (Number.isNaN(quarantinedAt) || quarantinedAt >= cutoff) continue;
    const meta = await readSessionMeta(file);
    candidates.push({
      threadId: metadata?.threadId || meta?.id || path.basename(file, ".jsonl"),
      path: file,
      originalPath: metadata?.originalPath || "",
      quarantinedAt: new Date(quarantinedAt).toISOString(),
      quarantineAgeDays: Math.floor((Date.now() - quarantinedAt) / 86_400_000),
      bytes: stat.size
    });
  }

  candidates.sort((left, right) => left.quarantinedAt.localeCompare(right.quarantinedAt));
  return candidates;
}

async function readCleanupMetadata(file) {
  try {
    return JSON.parse(await fs.readFile(`${file}.cleanup.json`, "utf8"));
  } catch {
    return null;
  }
}

async function collectProtectedThreadIds() {
  const protectedThreadIds = new Set();
  for (const chat of Object.values(state.chats)) {
    if (chat?.threadId) protectedThreadIds.add(chat.threadId);
  }
  for (const thread of threadCache.values()) {
    if (thread?.id) protectedThreadIds.add(thread.id);
  }
  for (const threadId of await listRunningCodexThreadIds()) {
    protectedThreadIds.add(threadId);
  }
  return protectedThreadIds;
}

async function listRunningCodexThreadIds() {
  try {
    const { stdout } = await execFileAsync("ps", ["-eo", "args="], { maxBuffer: 2 * 1024 * 1024 });
    const ids = new Set();
    const idPattern = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
    for (const line of stdout.split("\n")) {
      if (!line.toLowerCase().includes("codex")) continue;
      for (const match of line.matchAll(idPattern)) ids.add(match[0]);
    }
    return [...ids];
  } catch {
    return [];
  }
}

function startCleanupScheduler() {
  setTimeout(() => {
    runDailyCleanupCheck().catch((error) => {
      console.error("cleanup scheduler failed", error);
    });
  }, 5000);
  setInterval(() => {
    runDailyCleanupCheck().catch((error) => {
      console.error("cleanup scheduler failed", error);
    });
  }, 60_000);
}

async function runDailyCleanupCheck() {
  if (!runtimeValue("cleanupEnabled")) return;
  const clock = getLocalClock();
  if (state.cleanup.lastDailyDate === clock.dateKey) return;
  if (clock.time < runtimeValue("cleanupNotifyTime")) return;

  await sendDailyCleanupPlan();
  await runAutomaticCodexMaintenanceIfEnabled();
  await runDailyUploadCleanupIfEnabled();
  state.cleanup.lastDailyDate = clock.dateKey;
  pruneExpiredCleanupPlans();
  pruneExpiredUploadCleanupPlans();
  await saveState(config.stateFile, state);
}

async function runDailyUploadCleanupIfEnabled() {
  if (!shouldRunUploadCleanup({
    cleanupEnabled: runtimeValue("cleanupEnabled"),
    uploadCleanupEnabled: config.uploadCleanupEnabled
  })) return;
  const plan = await createUploadCleanupPlan({ dryRun: true });
  await appendCleanupLog(createUploadCleanupPlanLogEntry(plan));
}

async function runAutomaticCodexMaintenanceIfEnabled() {
  if (maintenanceAutoHandoffEnabled()) {
    const results = [];
    const seen = new Set();
    for (const chat of Object.values(state.chats)) {
      const threadId = chat?.threadId;
      if (!threadId || seen.has(threadId)) continue;
      seen.add(threadId);
      try {
        results.push(await createThreadHandoff(threadId));
      } catch (error) {
        results.push({ ok: false, threadId, error: error instanceof Error ? error.message : String(error) });
      }
    }
    await appendCleanupLog({ type: "auto_handoff", count: results.length, results, at: new Date().toISOString() });
  }

  if (maintenanceAutoSqliteRepairEnabled()) {
    if (activeTurns.size > 0) {
      await appendCleanupLog({ type: "auto_sqlite_repair_skipped", reason: "active_turns", count: activeTurns.size, at: new Date().toISOString() });
      return;
    }
    try {
      const result = await runCodexMaintenance("sqlite-metadata-repair");
      await appendCleanupLog({ type: "auto_sqlite_repair", result, at: new Date().toISOString() });
    } catch (error) {
      await appendCleanupLog({ type: "auto_sqlite_repair_error", message: error instanceof Error ? error.message : String(error), at: new Date().toISOString() });
    }
  }
}

function pruneExpiredCleanupPlans() {
  const now = Date.now();
  for (const [planId, plan] of Object.entries(state.cleanup.plans)) {
    if (!plan?.expiresAt || Date.parse(plan.expiresAt) < now) delete state.cleanup.plans[planId];
  }
}

function pruneExpiredUploadCleanupPlans() {
  const now = Date.now();
  for (const [planId, record] of Object.entries(state.uploadCleanup.plans)) {
    if (!record?.expiresAt || Date.parse(record.expiresAt) < now) delete state.uploadCleanup.plans[planId];
  }
}

async function appendCleanupLog(entry) {
  await appendPrivateFile(config.cleanupLogFile, `${JSON.stringify(entry)}\n`, "utf8");
}

async function createUploadCleanupPlan(options = {}) {
  return buildUploadCleanupPlanFromDisk(config.uploadDir, {
    retentionDays: config.uploadRetentionDays,
    maxBytes: config.uploadMaxBytes,
    dryRun: options.dryRun !== false
  });
}

function startStateSnapshotScheduler() {
  setTimeout(() => {
    runDailyStateSnapshotCheck().catch((error) => {
      console.error("snapshot scheduler failed", error);
    });
  }, 10_000);
  setInterval(() => {
    runDailyStateSnapshotCheck().catch((error) => {
      console.error("snapshot scheduler failed", error);
    });
  }, 60_000);
}

async function runDailyStateSnapshotCheck() {
  if (!runtimeValue("snapshotEnabled")) return;
  const clock = getLocalClock();
  if (state.snapshots.lastDailyDate === clock.dateKey) return;
  if (clock.time < runtimeValue("snapshotNotifyTime")) return;

  await createStateBackup("daily-snapshot");
  state.snapshots.lastDailyDate = clock.dateKey;
  await saveState(config.stateFile, state);
}

async function createStateBackup(source) {
  await ensurePrivateDirectory(config.backupDir);
  const createdAt = new Date().toISOString();
  const payload = {
    createdAt,
    source,
    app: await buildAppSummary(),
    config: buildConfigSummary(),
    stats: {
      chats: Object.keys(state.chats).length,
      cleanupPlans: Object.keys(state.cleanup.plans).length,
      activeTurns: activeTurns.size,
      pendingTurns: countPendingTurns(),
      cachedThreads: threadCache.size
    },
    state,
    cleanupLog: await readOptionalText(config.cleanupLogFile)
  };
  const filePath = path.join(config.backupDir, `${timestampForFilename(createdAt)}-${source}.json`);
  await writePrivateFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await pruneOldBackups();
  const stat = await fs.stat(filePath);
  return { path: filePath, bytes: stat.size, chatCount: payload.stats.chats };
}

async function createChatExport(chatKey) {
  await ensurePrivateDirectory(config.backupDir);
  const createdAt = new Date().toISOString();
  const chat = getChatState(chatKey);
  const payload = {
    createdAt,
    chatKey,
    chat,
    effectiveOptions: redactValue(getEffectiveOptions(chatKey)),
    activeTurn: activeTurns.has(chatKey),
    queuedTurns: getPendingTurns(chatKey).map(serializePendingTurn),
    cachedThreadId: threadCache.get(chatKey)?.id || ""
  };
  const filePath = path.join(config.backupDir, `${timestampForFilename(createdAt)}-chat-${safeFilename(chatKey)}.json`);
  await writePrivateFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  const stat = await fs.stat(filePath);
  return { path: filePath, bytes: stat.size };
}

async function pruneOldBackups() {
  let entries = [];
  try {
    entries = await fs.readdir(config.backupDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  const cutoff = Date.now() - runtimeValue("snapshotRetentionDays") * 24 * 60 * 60 * 1000;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const filePath = path.join(config.backupDir, entry.name);
    const stat = await fs.stat(filePath);
    if (stat.mtimeMs < cutoff) await fs.rm(filePath, { force: true });
  }
}

async function buildAppSummary() {
  const botPackage = await readJsonFile(path.join(appRoot, "package.json"));
  const sdkPackage = await readPackageJson("@openai/codex-sdk");
  return {
    botVersion: botPackage?.version || "",
    node: process.version,
    codexSdk: sdkPackage?.version || "",
    startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString()
  };
}

function buildConfigSummary() {
  return redactValue({
    codexWorkdir: config.codexWorkdir,
    codexPath: config.codexPath,
    codexModel: config.codexModel,
    codexApprovalPolicy: config.codexApprovalPolicy,
    codexSandboxMode: config.codexSandboxMode,
    codexReasoningEffort: config.codexReasoningEffort,
    codexWebSearch: config.codexWebSearch,
    codexNetworkAccess: config.codexNetworkAccess,
    codexWebSearchEnabled: config.codexWebSearchEnabled,
    codexSkipGitRepoCheck: config.codexSkipGitRepoCheck,
    codexAdditionalDirectories: config.codexAdditionalDirectories,
    telegramLiveProgressEnabled: runtimeValue("telegramLiveProgressEnabled"),
    telegramLiveProgressIntervalSeconds: Math.round(runtimeValue("telegramLiveProgressIntervalMs") / 1000),
    telegramLiveProgressMode: runtimeValue("telegramLiveProgressMode"),
    telegramLiveProgressSource: config.telegramLiveProgressSource,
    telegramLiveProgressDeletePolicy: config.telegramLiveProgressDeletePolicy,
    telegramPendingTurnsMax: runtimeValue("telegramPendingTurnsMax"),
    telegramPendingTurnMaxAgeSeconds: runtimeValue("telegramPendingTurnMaxAgeSeconds"),
    botRestartRecoveryEnabled: config.botRestartRecoveryEnabled,
    botRestartExitCode: config.botRestartExitCode,
    botRestartDrainTimeoutSeconds: config.botRestartDrainTimeoutSeconds,
    botRestartDelaySeconds: config.botRestartDelaySeconds,
    botRecoveryDir: config.botRecoveryDir,
    botRecoveryStaleSeconds: config.botRecoveryStaleSeconds,
    botRecoveryTurnTtlSeconds: config.botRecoveryTurnTtlSeconds,
    botRecoverySuspendAfter: config.botRecoverySuspendAfter,
    botRecoveryBackfillPollMs: config.botRecoveryBackfillPollMs,
    telegramLanguage: config.telegramLanguage,
    telegramTimeZone: config.telegramTimeZone,
    telegramLocale: config.telegramLocale,
    codexBaseUrl: config.codexBaseUrl,
    codexApiKey: config.codexApiKey ? "set" : "",
    codexConfig: config.codexConfig ? "set" : "",
    codexEnv: config.codexEnv ? "set" : "",
    codexAutoCompactTokenLimit: resolveAutoCompactTokenLimit(config) || "default",
    codexToolOutputTokenLimit: config.codexToolOutputTokenLimit || "default",
    codexCompactStrength: config.codexCompactStrength,
    codexContextGuardEnabled: config.codexContextGuardEnabled,
    codexContextCompactThresholdPercent: config.codexContextCompactThresholdPercent,
    codexContextMinRemainingTokens: config.codexContextMinRemainingTokens,
    stateFile: config.stateFile,
    codexSessionsDir: config.codexSessionsDir,
    uploadDir: config.uploadDir,
    backupDir: config.backupDir,
    cleanupQuarantineDir: config.cleanupQuarantineDir,
    cleanupEnabled: runtimeValue("cleanupEnabled"),
    cleanupNotifyTime: runtimeValue("cleanupNotifyTime"),
    cleanupRetentionDays: runtimeValue("cleanupRetentionDays"),
    cleanupQuarantineDays: runtimeValue("cleanupQuarantineDays"),
    cleanupPlanTtlHours: runtimeValue("cleanupPlanTtlHours"),
    snapshotEnabled: runtimeValue("snapshotEnabled"),
    snapshotNotifyTime: runtimeValue("snapshotNotifyTime"),
    snapshotRetentionDays: runtimeValue("snapshotRetentionDays")
  });
}

function getLocalClock() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: uiTimeZone(),
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).formatToParts(new Date()).map((part) => [part.type, part.value])
  );
  return {
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`
  };
}

function getLocalDateKey() {
  return getLocalClock().dateKey;
}

function formatDateTime(value) {
  return new Intl.DateTimeFormat(uiLocale(), {
    timeZone: uiTimeZone(),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short"
  }).format(new Date(value)).replace(",", "");
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 102.4) / 10} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
  return `${bytes} B`;
}

async function readLatestTokenCount(threadId) {
  const file = await findCodexSessionFile(threadId);
  if (!file) return null;
  let latest = null;
  const lines = (await fs.readFile(file, "utf8")).split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed?.payload?.type === "token_count") {
        latest = {
          tokenCount: parsed.payload,
          sampledAt: parsed.timestamp || parsed.time || parsed.created_at || ""
        };
      }
    } catch {
      // Ignore partial or non-JSON session lines.
    }
  }
  return latest;
}

async function buildBestCodexUsageSummary(chatKey, threadId) {
  const chat = getChatState(chatKey);
  const latest = await selectLatestUsageSample([
    { threadId, sourceLabel: "current thread" },
    { threadId: chat.usageProbeThreadId || "", sourceLabel: "usage probe" }
  ]);
  return formatCodexUsageSummary({
    tokenCount: latest?.tokenCount,
    sampledAt: latest?.sampledAt,
    sourceLabel: latest?.sourceLabel,
    now: new Date(),
    locale: uiLocale(),
    timeZone: uiTimeZone()
  });
}

async function selectLatestUsageSample(candidates) {
  let latest = null;
  const seen = new Set();
  for (const candidate of candidates) {
    if (!candidate.threadId || seen.has(candidate.threadId)) continue;
    seen.add(candidate.threadId);
    const sample = await readLatestTokenCount(candidate.threadId);
    if (!sample) continue;
    const sampledAt = Date.parse(sample.sampledAt);
    const latestSampledAt = latest ? Date.parse(latest.sampledAt) : Number.NEGATIVE_INFINITY;
    if (!latest || sampledAt >= latestSampledAt) {
      latest = { ...sample, sourceLabel: candidate.sourceLabel };
    }
  }
  return latest;
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

function formatTurn(turn) {
  return turn.finalResponse?.trim() || "";
}

function summarizeProgress(items) {
  const latest = items.at(-1);
  const counts = countBy(items, (item) => item.type);
  const parts = ["Codex progress"];
  if (counts.reasoning) parts.push(`reasoning:${counts.reasoning}`);
  if (counts.command_execution) parts.push(`cmd:${counts.command_execution}`);
  if (counts.file_change) parts.push(`files:${counts.file_change}`);
  if (counts.web_search) parts.push(`web:${counts.web_search}`);
  if (latest?.type === "command_execution") parts.push(`last: ${truncate(latest.command, 80)}`);
  if (latest?.type === "web_search") parts.push(`last: ${truncate(latest.query, 80)}`);
  return parts.join("\n");
}

function createLiveProgressState(active = null) {
  return {
    lastSentAt: 0,
    lastKey: "",
    active,
    chatKey: "",
    messageRefs: []
  };
}

function shouldDeleteLiveProgress(progressState, turnSucceeded) {
  const options = progressState?.chatKey ? getEffectiveOptions(progressState.chatKey) : defaultChatOptions();
  if (options.liveProgressDeletePolicy === "never") return false;
  if (options.liveProgressDeletePolicy === "on_success") return turnSucceeded;
  return true;
}

async function maybeSendLiveProgress(ctx, progressState, event, items) {
  if (!progressState) return false;
  const options = getEffectiveOptions(progressState.chatKey || getChatKey(ctx));
  if (!options.liveProgressEnabled) return false;
  if (!["brief", "korean-brief"].includes(runtimeValue("telegramLiveProgressMode"))) return false;
  const progress = buildLiveProgressMessage(event, items, options.liveProgressSource, uiLanguage());
  if (!progress) return false;
  if (progress.key === progressState.lastKey) return false;

  const now = Date.now();
  const intervalMs = Math.max(0, runtimeValue("telegramLiveProgressIntervalMs"));
  if (!progress.important && progressState.lastSentAt > 0 && now - progressState.lastSentAt < intervalMs) return false;

  progressState.lastSentAt = now;
  progressState.lastKey = progress.key;
  if (progressState.active) {
    progressState.active.lastProgress = stripHtml(progress.html);
    progressState.active.lastProgressAt = new Date(now).toISOString();
  }
  const result = await runTelegramProgressBestEffort(
    () => replyTrackedProgressHtml(ctx, progressState, progress.html),
    {
      onError: (errorSummary) => recordTelegramProgressFailed(progressState, event, errorSummary),
      logger: console
    }
  );
  return result.ok;
}

function buildLiveProgressMessage(event, items, source = "agent", language = "en") {
  const messages = [];
  if (source === "agent" || source === "both") {
    const agentMessage = buildAgentLiveProgressMessage(event);
    if (agentMessage) messages.push(agentMessage);
  }
  if (source === "activity" || source === "both") {
    const activityMessage = buildActivityLiveProgressMessage(event, items, language);
    if (activityMessage) messages.push(activityMessage);
  }
  if (messages.length === 0) return null;
  if (source !== "both" || messages.length === 1) return messages[0];
  return {
    key: messages.map((message) => message.key).join("|"),
    html: messages.map((message) => message.html).join("\n\n"),
    important: messages.some((message) => message.important)
  };
}

function buildAgentLiveProgressMessage(event) {
  if (event.type !== "item.started" && event.type !== "item.updated" && event.type !== "item.completed") return null;

  const item = event.item;
  if (!item) return null;

  if (item.type === "agent_message") {
    const text = String(item.text || "").trim();
    if (!text) return null;
    return {
      key: `agent-message-${item.id}-${hashString(text)}`,
      html: formatLiveAgentMessageHtml(text),
      important: event.type === "item.completed"
    };
  }
  return null;
}

function buildActivityLiveProgressMessage(event, items, language = "en") {
  if (event.type === "turn.started") {
    return { key: "turn-started", html: lt(language, "liveTurnStarted"), important: true };
  }
  if (event.type === "turn.completed") {
    return { key: "turn-completed", html: lt(language, "liveTurnCompleted"), important: true };
  }
  if (event.type !== "item.started" && event.type !== "item.updated" && event.type !== "item.completed") return null;

  const item = event.item;
  if (!item) return null;
  if (item.type === "reasoning") {
    return { key: "reasoning", html: lt(language, "liveReasoning"), important: false };
  }
  if (item.type === "todo_list") {
    const remaining = item.items?.filter((todo) => !todo.completed).length ?? 0;
    return {
      key: `todo-${remaining}`,
      html: remaining > 0
        ? ltf(language, "liveTodoRemaining", { remaining: code(remaining) })
        : lt(language, "liveTodoOrganizing"),
      important: false
    };
  }
  if (item.type === "command_execution") {
    const command = shortCommand(item.command || "");
    if (item.status === "failed") {
      return { key: `cmd-failed-${item.id}`, html: ltf(language, "liveCommandFailed", { command: code(command) }), important: true };
    }
    if (item.status === "completed") {
      return { key: `cmd-done-${item.id}`, html: ltf(language, "liveCommandFinished", { command: code(command) }), important: false };
    }
    return { key: `cmd-running-${item.id}`, html: ltf(language, "liveCommandRunning", { command: code(command) }), important: false };
  }
  if (item.type === "file_change") {
    const paths = summarizeFileChangePaths(item);
    if (item.status === "failed") {
      return { key: `file-failed-${item.id}`, html: lt(language, "liveFileFailed"), important: true };
    }
    return { key: `file-done-${item.id}`, html: ltf(language, "liveFileUpdated", { paths: code(paths || lt(language, "liveChangedFiles")) }), important: true };
  }
  if (item.type === "mcp_tool_call") {
    const tool = shortToolName(item);
    if (item.status === "failed") {
      return { key: `tool-failed-${item.id}`, html: ltf(language, "liveToolFailed", { tool: code(tool) }), important: true };
    }
    if (item.status === "completed") {
      return { key: `tool-done-${item.id}`, html: ltf(language, "liveToolFinished", { tool: code(tool) }), important: false };
    }
    return { key: `tool-running-${item.id}`, html: ltf(language, "liveToolRunning", { tool: code(tool) }), important: false };
  }
  if (item.type === "web_search") {
    if (event.type === "item.completed") return { key: `web-done-${item.id}`, html: lt(language, "liveWebFinished"), important: false };
    return { key: `web-running-${item.id}`, html: lt(language, "liveWebRunning"), important: false };
  }
  if (item.type === "error") {
    return { key: `item-error-${item.id}`, html: lt(language, "liveItemError"), important: true };
  }
  if (item.type === "agent_message" && event.type !== "item.completed") {
    return { key: "agent-message-draft", html: lt(language, "liveAgentDraft"), important: false };
  }
  return null;
}

function formatLiveAgentMessageHtml(text) {
  const max = Math.min(Math.max(500, runtimeValue("maxTelegramChars")), 2000);
  const body = truncate(text.trim(), max);
  return runtimeValue("telegramFormatCodexAnswers") === "markdown"
    ? formatCodexAnswerMarkdownHtml(body)
    : formatCodexAnswerSafeHtml(body);
}

function hashString(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function shortCommand(command) {
  return truncate(redactText(String(command || "").replace(/\s+/g, " ").trim()) || "command", 90);
}

function shortToolName(item) {
  return truncate([item.server, item.tool].filter(Boolean).join("/") || "tool", 80);
}

function summarizeFileChangePaths(item) {
  const paths = (item.changes ?? []).map((change) => change.path).filter(Boolean);
  if (paths.length === 0) return "";
  const summary = paths.slice(0, 3).join(", ");
  return paths.length > 3 ? `${summary}, +${paths.length - 3}` : summary;
}

async function sendPanel(ctx, panel, options = {}) {
  const chatKey = getChatKey(ctx);
  const edit = options.edit === true;
  let html = "";
  let keyboard = {};

  if (panel === "main") {
    html = await formatMainPanelHtml(chatKey);
    keyboard = mainPanelKeyboard(chatKey);
  } else if (panel === "status") {
    await pruneExpiredPendingTurns(chatKey, ctx);
    html = formatStatusHtml(chatKey, await buildStatusDetails(chatKey));
    keyboard = statusKeyboard(chatKey);
  } else if (panel === "queue") {
    await pruneExpiredPendingTurns(chatKey, ctx);
    html = formatQueueHtml(chatKey);
    keyboard = queueKeyboard(chatKey);
  } else if (panel === "settings") {
    html = settingsPanelHtml(chatKey);
    keyboard = settingsKeyboard();
  } else if (panel === "settings_model") {
    const models = await listCodexModels();
    html = formatModelSelectionHtml(chatKey, models);
    keyboard = settingsSelectionKeyboard(modelSelectionKeyboard(models), "settings");
  } else if (panel === "settings_reasoning") {
    const models = await listCodexModels();
    html = formatReasoningPromptHtml(chatKey, models);
    keyboard = settingsSelectionKeyboard(
      reasoningSelectionKeyboard(reasoningOptionsForModel(models, effectiveModelSlug(chatKey))),
      "settings"
    );
  } else if (panel === "settings_fast") {
    html = await fastPanelHtml(chatKey);
    keyboard = fastKeyboard();
  } else if (panel === "settings_sandbox") {
    html = settingPanelHtml("Sandbox", getEffectiveOptions(chatKey).sandboxMode, t("sandboxDescription"));
    keyboard = sandboxKeyboard();
  } else if (panel === "settings_approval") {
    html = settingPanelHtml("Approval", getEffectiveOptions(chatKey).approvalPolicy, t("approvalDescription"));
    keyboard = approvalKeyboard();
  } else if (panel === "settings_web") {
    html = settingPanelHtml("Web Search", getEffectiveOptions(chatKey).webSearchMode, t("webDescription"));
    keyboard = webSearchKeyboard();
  } else if (panel === "settings_network") {
    html = settingPanelHtml("Network", formatOptional(getEffectiveOptions(chatKey).networkAccessEnabled), t("networkDescription"));
    keyboard = booleanOptionKeyboard("network");
  } else if (panel === "settings_stream") {
    html = settingPanelHtml("Stream", String(getEffectiveOptions(chatKey).streamEvents), t("streamDescription"));
    keyboard = booleanOptionKeyboard("stream");
  } else if (panel === "settings_live_progress") {
    html = liveProgressPanelHtml(chatKey);
    keyboard = liveProgressKeyboard(chatKey);
  } else if (panel === "settings_runtime") {
    html = runtimePanelHtml();
    keyboard = runtimeKeyboard();
  } else if (panel === "settings_runtime_output") {
    html = runtimeOutputPanelHtml();
    keyboard = runtimeOutputKeyboard();
  } else if (panel === "settings_runtime_queue") {
    html = runtimeQueuePanelHtml();
    keyboard = runtimeQueueKeyboard();
  } else if (panel === "settings_runtime_codex") {
    html = runtimeCodexPanelHtml();
    keyboard = runtimeCodexKeyboard();
  } else if (panel === "settings_runtime_cleanup") {
    html = runtimeCleanupPanelHtml();
    keyboard = runtimeCleanupKeyboard();
  } else if (panel === "settings_runtime_snapshot") {
    html = runtimeSnapshotPanelHtml();
    keyboard = runtimeSnapshotKeyboard();
  } else if (panel === "settings_git") {
    html = settingPanelHtml("Git Check", String(getEffectiveOptions(chatKey).skipGitRepoCheck), t("gitDescription"));
    keyboard = booleanOptionKeyboard("skipgit");
  } else if (panel === "settings_paths") {
    html = pathsPanelHtml(chatKey);
    keyboard = pathsKeyboard();
  } else if (panel === "settings_schema") {
    html = schemaPanelHtml(chatKey);
    keyboard = schemaKeyboard();
  } else if (panel === "settings_language") {
    html = settingPanelHtml(t("languageTitle"), uiLanguage(), t("languageDescription"));
    keyboard = languageKeyboard();
  } else if (panel === "settings_timezone") {
    html = settingPanelHtml(t("timeZoneTitle"), uiTimeZone(), t("timeZoneDescription"));
    keyboard = timeZoneKeyboard();
  } else if (panel.startsWith("settings_timezone_")) {
    const groupId = panel.slice("settings_timezone_".length);
    html = timeZoneGroupPanelHtml(groupId);
    keyboard = timeZoneGroupKeyboard(groupId);
  } else if (panel === "settings_locale") {
    html = settingPanelHtml(t("localeTitle"), uiLocale(), t("localeDescription"));
    keyboard = localeKeyboard();
  } else if (panel === "tools") {
    html = toolsPanelHtml(chatKey);
    keyboard = toolsKeyboard();
  } else if (panel === "help") {
    html = helpTextHtml();
    keyboard = backToMainKeyboard();
  } else {
    html = await formatMainPanelHtml(chatKey);
    keyboard = mainPanelKeyboard(chatKey);
  }

  keyboard = withMenuCloseButton(withPreviousPanelButton(keyboard, previousPanelFor(panel)));
  if (edit) return editOrReplyHtml(ctx, html, keyboard);
  return replyHtml(ctx, html, keyboard);
}

async function formatMainPanelHtml(chatKey) {
  return renderMainPanelHtml({
    details: await buildStatusDetails(chatKey),
    options: getEffectiveOptions(chatKey),
    transport: runtimeValue("codexTransport")
  });
}

function settingsPanelHtml(chatKey) {
  return renderSettingsPanelHtml(formatOptionsHtml(chatKey));
}

async function fastPanelHtml(chatKey) {
  return renderFastPanelHtml(await formatFastStatusHtml(chatKey, await listCodexModels()));
}

function settingPanelHtml(title, current, description) {
  return renderSettingPanelHtml(title, current, description);
}

function pathsPanelHtml(chatKey) {
  return renderPathsPanelHtml(getEffectiveOptions(chatKey));
}

function schemaPanelHtml(chatKey) {
  return renderSchemaPanelHtml(Boolean(getChatState(chatKey).outputSchema));
}

function liveProgressPanelHtml(chatKey) {
  return renderLiveProgressPanelHtml({
    options: getEffectiveOptions(chatKey),
    mode: runtimeValue("telegramLiveProgressMode"),
    intervalSeconds: runtimeSeconds("telegramLiveProgressIntervalMs")
  });
}

function runtimePanelHtml() {
  return renderRuntimePanelHtml(runtimeSummaryHtml());
}
function runtimeSummaryHtml() {
  return formatKeyValueHtml("Runtime overrides:", [
    ["worker mode", runtimeValue("codexWorkerMode")],
    ["codex transport", runtimeValue("codexTransport")],
    ["reactions", runtimeValue("telegramReactionsEnabled")],
    ["answer format", runtimeValue("telegramFormatCodexAnswers")],
    ["completion notice", `${runtimeValue("telegramCompletionNoticeSeconds")}s`],
    ["queue max", runtimeValue("telegramPendingTurnsMax")],
    ["queue expiry", runtimeValue("telegramPendingTurnMaxAgeSeconds") <= 0 ? "off" : formatDurationSeconds(runtimeValue("telegramPendingTurnMaxAgeSeconds"))],
    ["cleanup", runtimeValue("cleanupEnabled") ? `${runtimeValue("cleanupNotifyTime")} ${uiTimeZone()}` : "off"],
    ["snapshot", runtimeValue("snapshotEnabled") ? `${runtimeValue("snapshotNotifyTime")} ${uiTimeZone()}` : "off"],
    ["logs max lines", runtimeValue("logsMaxLines")],
    ["max message chars", runtimeValue("maxTelegramChars")]
  ]);
}

function runtimeOutputPanelHtml() {
  return formatKeyValueHtml("Output runtime:", [
    ["reactions", runtimeValue("telegramReactionsEnabled")],
    ["answer format", runtimeValue("telegramFormatCodexAnswers")],
    ["completion notice seconds", runtimeValue("telegramCompletionNoticeSeconds")],
    ["max Telegram chars", runtimeValue("maxTelegramChars")],
    ["logs max lines", runtimeValue("logsMaxLines")],
    ["progress edit interval", `${runtimeSeconds("progressEditIntervalMs")}s`]
  ]);
}

function runtimeQueuePanelHtml() {
  return formatKeyValueHtml("Queue runtime:", [
    ["pending turns max", runtimeValue("telegramPendingTurnsMax")],
    ["pending max age seconds", runtimeValue("telegramPendingTurnMaxAgeSeconds")],
    ["pending max age", runtimeValue("telegramPendingTurnMaxAgeSeconds") <= 0 ? "off" : formatDurationSeconds(runtimeValue("telegramPendingTurnMaxAgeSeconds"))]
  ]);
}

function runtimeCodexPanelHtml() {
  return formatKeyValueHtml("Codex runtime:", [
    ["worker mode", runtimeValue("codexWorkerMode")],
    ["worker socket", config.codexWorkerSocket],
    ["worker poll", `${runtimeValue("codexWorkerEventPollMs")}ms`],
    ["transport", runtimeValue("codexTransport")],
    ["app-server direct timeout", `${runtimeValue("codexAppServerDirectTimeoutMs")}ms`],
    ["codex path", config.codexPath]
  ]);
}

function runtimeCleanupPanelHtml() {
  return formatKeyValueHtml("Cleanup runtime:", [
    ["enabled", runtimeValue("cleanupEnabled")],
    ["notify time", `${runtimeValue("cleanupNotifyTime")} ${uiTimeZone()}`],
    ["retention days", runtimeValue("cleanupRetentionDays")],
    ["quarantine days", runtimeValue("cleanupQuarantineDays")],
    ["plan ttl hours", runtimeValue("cleanupPlanTtlHours")]
  ]);
}

function runtimeSnapshotPanelHtml() {
  return formatKeyValueHtml("Snapshot runtime:", [
    ["enabled", runtimeValue("snapshotEnabled")],
    ["notify time", `${runtimeValue("snapshotNotifyTime")} ${uiTimeZone()}`],
    ["retention days", runtimeValue("snapshotRetentionDays")]
  ]);
}

function toolsPanelHtml(chatKey) {
  const chat = getChatState(chatKey);
  return renderToolsPanelHtml({
    threadId: chat.threadId || threadCache.get(chatKey)?.id,
    savedChats: Object.keys(state.chats).length,
    pendingTurns: countPendingTurns()
  });
}

function timeZoneGroupPanelHtml(groupId) {
  return renderTimeZoneGroupPanelHtml(groupId, uiTimeZone());
}

async function handleQueueButton(ctx, action, value) {
  const chatKey = getChatKey(ctx);
  await pruneExpiredPendingTurns(chatKey, ctx);
  if (action === "pause") {
    await setQueuePaused(chatKey, true);
    await editOrReplyHtml(ctx, `${b(t("queuePausedTitle"))}\n${t("queuePausedDetail")}\n\n${formatQueueHtml(chatKey)}`, queueKeyboard(chatKey));
    return;
  }
  if (action === "resume") {
    await setQueuePaused(chatKey, false);
    await startQueueDrainIfIdle(chatKey, ctx);
    await editOrReplyHtml(ctx, `${b(t("queueResumedTitle"))}\n\n${formatQueueHtml(chatKey)}`, queueKeyboard(chatKey));
    return;
  }
  if (action === "mode") {
    if (!VALID.queueMode.has(value)) {
      await editOrReplyHtml(ctx, `${b("Invalid queue mode")}\n${code(value || "empty")}`, queueKeyboard(chatKey));
      return;
    }
    await setQueueMode(chatKey, value);
    await editOrReplyHtml(ctx, `${b(t("queueUpdatedTitle"))}\n\n${formatQueueHtml(chatKey)}`, queueKeyboard(chatKey));
    return;
  }
  if (action === "clear") {
    await editOrReplyHtml(ctx, `${b(t("queueClearConfirmTitle"))}\n${t("queueClearConfirmBody")}`, withMenuCloseButton(inlineKeyboard([
      [
        { text: t("clearAll"), callback_data: "confirm:q_clear" },
        { text: t("cancel"), callback_data: "p:queue" }
      ],
      [{ text: `← ${t("back")}`, callback_data: "p:queue" }]
    ])));
  }
}

async function handleSettingButton(ctx, key, value) {
  const chatKey = getChatKey(ctx);
  if (await rejectCallbackIfActive(ctx, chatKey)) return;
  try {
    if (key === "fast") await setOption(chatKey, "serviceTier", value === "on" ? "fast" : "default");
    else if (key === "sandbox") await setOption(chatKey, "sandboxMode", mapSandboxValue(value));
    else if (key === "approval") await setOption(chatKey, "approvalPolicy", value.replaceAll("_", "-"));
    else if (key === "web") await setOption(chatKey, "webSearchMode", value);
    else if (key === "network") await setOption(chatKey, "networkAccessEnabled", value);
    else if (key === "stream") await setOption(chatKey, "streamEvents", value);
    else if (key === "liveprogress") await setOption(chatKey, "liveProgressEnabled", value);
    else if (key === "liveprogresssource") await setOption(chatKey, "liveProgressSource", value);
    else if (key === "liveprogressdelete") await setOption(chatKey, "liveProgressDeletePolicy", value);
    else if (key.startsWith("runtime_")) {
      await updateRuntimeSetting(runtimeSettingKey(key), runtimeSettingValue(key, value));
      await editOrReplyHtml(ctx, `${b(t("runtimeUpdated"))}\n\n${runtimePanelHtml()}`, runtimeKeyboard());
      return;
    }
    else if (key === "skipgit") await setOption(chatKey, "skipGitRepoCheck", value);
    else if (key === "workdir") await setOption(chatKey, "workingDirectory", value);
    else if (key === "language") {
      state.ui.language = parseLanguage(value);
      await saveState(config.stateFile, state);
      await editOrReplyHtml(ctx, `${b(t("languageUpdated"))}\n\n${settingsPanelHtml(chatKey)}`, settingsKeyboard());
      await registerTelegramCommands().catch((error) => console.warn("setMyCommands after language update failed:", summarizeTelegramError(error)));
      return;
    }
    else if (key === "timezone") {
      state.ui.timeZone = value === "default" ? config.telegramTimeZone : timeZoneFromChoice(value);
      await saveState(config.stateFile, state);
      await editOrReplyHtml(ctx, `${b(t("timeZoneUpdated"))}\n\n${settingsPanelHtml(chatKey)}`, settingsKeyboard());
      return;
    }
    else if (key === "locale") {
      state.ui.locale = value === "default" ? config.telegramLocale : localeFromChoice(value);
      await saveState(config.stateFile, state);
      await editOrReplyHtml(ctx, `${b(t("localeUpdated"))}\n\n${settingsPanelHtml(chatKey)}`, settingsKeyboard());
      return;
    }
    else if (key === "dirs" && value === "clear") {
      delete getChatState(chatKey).options.additionalDirectories;
      invalidateThreadCache(chatKey);
    } else if (key === "schema" && value === "off") {
      delete getChatState(chatKey).outputSchema;
    } else {
      throw new Error(`Unknown setting action: ${key}:${value}`);
    }
  } catch (error) {
    await editOrReplyHtml(ctx, `${b(t("settingFailure"))}\n${code(error instanceof Error ? error.message : String(error))}`, settingsKeyboard());
    return;
  }
  await saveState(config.stateFile, state);
  await editOrReplyHtml(ctx, `${b(t("settingUpdated"))}\n\n${settingsPanelHtml(chatKey)}`, settingsKeyboard());
}

function mapSandboxValue(value) {
  if (value === "ro") return "read-only";
  if (value === "ww") return "workspace-write";
  if (value === "danger") return "danger-full-access";
  return value;
}

function timeZoneFromChoice(id) {
  const choice = TIME_ZONE_CHOICES.find(([choiceId]) => choiceId === id);
  if (!choice) throw new Error(`Unknown time zone: ${id}`);
  return parseTimeZone(choice[2]);
}

function localeFromChoice(id) {
  const choice = LOCALE_CHOICES.find(([choiceId]) => choiceId === id);
  if (!choice) throw new Error(`Unknown locale: ${id}`);
  return parseLocale(choice[2]);
}

function runtimeSettingKey(actionKey) {
  const map = {
    runtime_reactions: "telegramReactionsEnabled",
    runtime_answerformat: "telegramFormatCodexAnswers",
    runtime_completionnotice: "telegramCompletionNoticeSeconds",
    runtime_pendingmax: "telegramPendingTurnsMax",
    runtime_pendingage: "telegramPendingTurnMaxAgeSeconds",
    runtime_workermode: "codexWorkerMode",
    runtime_workerpoll: "codexWorkerEventPollMs",
    runtime_codextransport: "codexTransport",
    runtime_appservertimeout: "codexAppServerDirectTimeoutMs",
    runtime_liveprogressmode: "telegramLiveProgressMode",
    runtime_liveprogressinterval: "telegramLiveProgressIntervalMs",
    runtime_cleanup: "cleanupEnabled",
    runtime_cleanuptime: "cleanupNotifyTime",
    runtime_cleanupretention: "cleanupRetentionDays",
    runtime_cleanupquarantine: "cleanupQuarantineDays",
    runtime_cleanupttl: "cleanupPlanTtlHours",
    runtime_snapshot: "snapshotEnabled",
    runtime_snapshottime: "snapshotNotifyTime",
    runtime_snapshotretention: "snapshotRetentionDays",
    runtime_logsmax: "logsMaxLines",
    runtime_maxchars: "maxTelegramChars",
    runtime_progressedit: "progressEditIntervalMs"
  };
  const key = map[actionKey];
  if (!key) throw new Error(`Unknown runtime action: ${actionKey}`);
  return key;
}

function runtimeSettingValue(actionKey, value) {
  if (value === "korean_brief") return "korean-brief";
  if (actionKey === "runtime_cleanuptime" || actionKey === "runtime_snapshottime") return value.replaceAll("_", ":");
  return value;
}

async function handleAppServerStatusButton(ctx) {
  const rows = [
    ["transport", runtimeValue("codexTransport")],
    ["direct args", appServerDirectArgs().join(" ")],
    ["timeout", `${runtimeValue("codexAppServerDirectTimeoutMs")}ms`]
  ];
  try {
    const result = await readCommandOutput(config.codexPath, ["app-server", "--help"], runtimeValue("codexAppServerDirectTimeoutMs"));
    const supportsStdio = result.ok && result.output.includes("--stdio");
    rows.push(["status", result.ok ? (supportsStdio ? "available" : "unsupported") : "failed"]);
    rows.push(["help", supportsStdio ? truncate(result.output, 120) : truncate(result.output || result.error || "missing --stdio support", 180)]);
  } catch (error) {
    rows.push(["status", "failed"]);
    rows.push(["error", truncate(error instanceof Error ? error.message : String(error), 240)]);
  }
  await editOrReplyHtml(ctx, formatKeyValueHtml("Codex app-server direct:", rows), runtimeCodexKeyboard());
}

async function handleWorkerStatusButton(ctx) {
  const rows = [
    ["worker mode", runtimeValue("codexWorkerMode")],
    ["socket", config.codexWorkerSocket],
    ["poll", `${runtimeValue("codexWorkerEventPollMs")}ms`]
  ];
  try {
    const status = await getWorkerClient().status();
    rows.push(["status", status.status || "ok"]);
    rows.push(["active jobs", status.activeJobs?.length ?? 0]);
    rows.push(["running jobs", status.runningJobIds?.length ?? 0]);
  } catch (error) {
    rows.push(["status", "failed"]);
    rows.push(["error", truncate(error instanceof Error ? error.message : String(error), 240)]);
  }
  await editOrReplyHtml(ctx, formatKeyValueHtml("Codex worker:", rows), runtimeCodexKeyboard());
}

async function handleToolButton(ctx, action) {
  const chatKey = getChatKey(ctx);
  if (action === "health") {
    await editOrReplyHtml(ctx, await formatHealthHtml(), withToolsBack());
  } else if (action === "doctor") {
    await editOrReplyHtml(ctx, await formatDoctorHtml(chatKey), withToolsBack());
  } else if (action === "logs") {
    await editOrReplyHtml(ctx, await formatLogsHtml(ctx), withToolsBack());
  } else if (action === "logs_error") {
    await editOrReplyHtml(ctx, await formatLogsHtml(ctx, "error"), withToolsBack());
  } else if (action === "whoami") {
    await editOrReplyHtml(ctx, formatWhoamiHtml(ctx), withToolsBack());
  } else if (action === "config") {
    await editOrReplyHtml(ctx, formatConfigHtml(), withToolsBack());
  } else if (action === "skills") {
    await replyCodexSkillsStatus(ctx, { config, runtimeValue, replyHtml, editOrReplyHtml }, { edit: true, extra: withToolsBack() });
  } else if (action === "appserver_status") {
    await handleAppServerStatusButton(ctx);
  } else if (action === "worker_status") {
    await handleWorkerStatusButton(ctx);
  } else if (action === "backup") {
    const backup = await createStateBackup("manual");
    await replyHtml(ctx, formatKeyValueHtml("Backup created:", [
      ["file", backup.path],
      ["size", formatBytes(backup.bytes)],
      ["chats", backup.chatCount]
    ]));
    await replyDocumentQuietly(ctx, backup.path, "Codex Telegram Bot backup");
  } else if (action === "export") {
    const file = await createChatExport(chatKey);
    await replyHtml(ctx, formatKeyValueHtml("Chat export created:", [
      ["file", file.path],
      ["size", formatBytes(file.bytes)]
    ]));
    await replyDocumentQuietly(ctx, file.path, "Current chat export");
  } else if (action === "cleanup") {
    await handleCleanupCommand(ctx);
  } else if (action === "codex_maintenance") {
    await editOrReplyHtml(ctx, codexMaintenanceMenuHtml(), codexMaintenanceKeyboard());
  } else if (action === "codex_maintenance_report") {
    await editOrReplyHtml(ctx, formatCodexMaintenanceReportHtml(await readCodexMaintenanceReport()), codexMaintenanceKeyboard());
  } else if (action === "codex_maintenance_backup") {
    await editOrReplyHtml(ctx, `${b(t("busyBackup"))}\n${t("busyBackupDetail")}`, codexMaintenanceBusyKeyboard());
    await editOrReplyHtml(ctx, formatCodexMaintenanceResultHtml(await runCodexMaintenance("backup")), codexMaintenanceKeyboard());
  } else if (action === "codex_maintenance_config") {
    if (await rejectCallbackIfActive(ctx, chatKey)) return;
    await editOrReplyHtml(ctx, `${b(t("busyConfig"))}\n${t("busyConfigDetail")}`, codexMaintenanceBusyKeyboard());
    await editOrReplyHtml(ctx, formatCodexMaintenanceResultHtml(await runCodexMaintenance("config-prune")), codexMaintenanceKeyboard());
  } else if (action === "codex_maintenance_worktrees") {
    if (await rejectCallbackIfActive(ctx, chatKey)) return;
    await editOrReplyHtml(ctx, `${b(t("busyWorktrees"))}\n${t("busyWorktreesDetail")}`, codexMaintenanceBusyKeyboard());
    await editOrReplyHtml(ctx, formatCodexMaintenanceResultHtml(await runCodexMaintenance("worktree-archive")), codexMaintenanceKeyboard());
  } else if (action === "codex_maintenance_logs") {
    if (await rejectCallbackIfActive(ctx, chatKey)) return;
    await editOrReplyHtml(ctx, `${b(t("busyLogs"))}\n${t("busyLogsDetail")}`, codexMaintenanceBusyKeyboard());
    await editOrReplyHtml(ctx, formatCodexMaintenanceResultHtml(await runCodexMaintenance("log-rotate")), codexMaintenanceKeyboard());
  } else if (action === "codex_maintenance_sqlite_repair") {
    await editOrReplyHtml(ctx, codexMaintenanceSqliteRepairConfirmHtml(), withMenuCloseButton(inlineKeyboard([
      [
        { text: t("repairRun"), callback_data: "tool:codex_maintenance_sqlite_repair_apply", style: "danger" },
        { text: t("cancel"), callback_data: "tool:codex_maintenance", style: "primary" }
      ],
      [{ text: `← ${t("back")}`, callback_data: "tool:codex_maintenance" }]
    ])));
  } else if (action === "codex_maintenance_sqlite_repair_apply") {
    if (await rejectCallbackIfActive(ctx, chatKey)) return;
    await editOrReplyHtml(ctx, `${b(t("busyRepair"))}\n${t("busyRepairDetail")}`, codexMaintenanceBusyKeyboard());
    await editOrReplyHtml(ctx, formatCodexMaintenanceResultHtml(await runCodexMaintenance("sqlite-metadata-repair")), codexMaintenanceKeyboard());
  } else if (action === "codex_maintenance_handoff") {
    if (await rejectCallbackIfActive(ctx, chatKey)) return;
    await editOrReplyHtml(ctx, `${b(t("busyHandoff"))}\n${t("busyHandoffDetail")}`, codexMaintenanceBusyKeyboard());
    await editOrReplyHtml(ctx, formatHandoffResultHtml(await createCurrentThreadHandoff(chatKey)), codexMaintenanceKeyboard());
  } else if (action === "codex_maintenance_auto_handoff") {
    state.maintenance.autoHandoffEnabled = !maintenanceAutoHandoffEnabled();
    await saveState(config.stateFile, state);
    await editOrReplyHtml(ctx, codexMaintenanceMenuHtml(), codexMaintenanceKeyboard());
  } else if (action === "codex_maintenance_auto_sqlite_repair") {
    state.maintenance.autoSqliteRepairEnabled = !maintenanceAutoSqliteRepairEnabled();
    await saveState(config.stateFile, state);
    await editOrReplyHtml(ctx, codexMaintenanceMenuHtml(), codexMaintenanceKeyboard());
  } else if (action === "forget") {
    await editOrReplyHtml(ctx, `${b(t("forgetConfirmTitle"))}\n${t("forgetConfirmBody")}`, withMenuCloseButton(inlineKeyboard([
      [
        { text: t("forgetRun"), callback_data: "confirm:forget" },
        { text: t("cancel"), callback_data: "p:tools" }
      ],
      [{ text: `← ${t("back")}`, callback_data: "p:tools" }]
    ])));
  }
}

function withToolsBack() {
  return withMenuCloseButton(inlineKeyboard([
    [{ text: t("tools"), callback_data: "p:tools" }, { text: t("main"), callback_data: "p:main" }],
    [{ text: `← ${t("back")}`, callback_data: "p:tools" }]
  ]));
}

function codexMaintenanceMenuHtml() {
  return [
    b(t("codexMaintenance")),
    "",
    t("maintenanceIntro"),
    t("maintenanceScope"),
    `${t("autoSqliteRepair")}: ${code(maintenanceAutoSqliteRepairEnabled() ? "on" : "off")}`,
    `${t("autoHandoff")}: ${code(maintenanceAutoHandoffEnabled() ? "on" : "off")}`,
    "",
    `- Report: ${t("maintenanceReportDesc")}`,
    `- Backup: ${t("maintenanceBackupDesc")}`,
    `- Config prune: ${t("maintenanceConfigDesc")}`,
    `- Worktrees: ${t("maintenanceWorktreesDesc")}`,
    `- Logs: ${t("maintenanceLogsDesc")}`,
    `- SQLite repair: ${t("maintenanceRepairDesc")}`,
    `- Handoff: ${t("maintenanceHandoffDesc")}`
  ].join("\n");
}

function codexMaintenanceKeyboard() {
  return withMenuCloseButton(inlineKeyboard([
    [
      { text: "📊 Report", callback_data: "tool:codex_maintenance_report", style: "primary" },
      { text: "💾 Backup", callback_data: "tool:codex_maintenance_backup", style: "success" }
    ],
    [
      { text: "🧹 Config prune", callback_data: "tool:codex_maintenance_config", style: "primary" },
      { text: "📦 Worktrees archive", callback_data: "tool:codex_maintenance_worktrees", style: "primary" }
    ],
    [
      { text: "🗄️ Logs rotate", callback_data: "tool:codex_maintenance_logs", style: "primary" }
    ],
    [
      { text: "🧬 SQLite repair", callback_data: "tool:codex_maintenance_sqlite_repair", style: "danger" },
      { text: t("handoffCreate"), callback_data: "tool:codex_maintenance_handoff", style: "success" }
    ],
    [
      { text: `🤖 Auto handoff ${maintenanceAutoHandoffEnabled() ? "on" : "off"}`, callback_data: "tool:codex_maintenance_auto_handoff", style: maintenanceAutoHandoffEnabled() ? "success" : "primary" },
      { text: `🤖 Auto repair ${maintenanceAutoSqliteRepairEnabled() ? "on" : "off"}`, callback_data: "tool:codex_maintenance_auto_sqlite_repair", style: maintenanceAutoSqliteRepairEnabled() ? "danger" : "primary" }
    ],
    [
      { text: t("tools"), callback_data: "p:tools" },
      { text: t("main"), callback_data: "p:main" }
    ],
    [
      { text: `← ${t("back")}`, callback_data: "p:tools" }
    ]
  ]));
}

function codexMaintenanceSqliteRepairConfirmHtml() {
  return [
    b(t("sqliteConfirmTitle")),
    "",
    t("sqliteConfirmBody"),
    `title limit: ${code(config.codexMaintenanceThreadTitleLimit)}`,
    `preview limit: ${code(config.codexMaintenanceThreadPreviewLimit)}`,
    "",
    `- ${t("sqliteNoTranscript")}`,
    `- ${t("sqliteRestore")}`,
    `- ${t("sqliteAutoOff")}`,
    "",
    t("sqliteContinue")
  ].join("\n");
}

function codexMaintenanceBusyKeyboard() {
  return inlineKeyboard([[{ text: t("processing"), callback_data: "tool:codex_maintenance", style: "primary" }]]);
}

function maintenanceAutoSqliteRepairEnabled() {
  return state.maintenance?.autoSqliteRepairEnabled === true;
}

function maintenanceAutoHandoffEnabled() {
  return state.maintenance?.autoHandoffEnabled === true;
}

async function readCodexMaintenanceReport() {
  return runCodexMaintenance("report");
}

async function runCodexMaintenance(action) {
  const args = [
    config.codexMaintenanceScript,
    action,
    "--codex-home",
    config.codexHome,
    "--worktree-older-than-days",
    String(config.codexMaintenanceWorktreeDays),
    "--rotate-logs-above-mb",
    String(config.codexMaintenanceLogRotateMb),
    "--thread-title-limit",
    String(config.codexMaintenanceThreadTitleLimit),
    "--thread-preview-limit",
    String(config.codexMaintenanceThreadPreviewLimit)
  ];
  if (action !== "report") {
    args.push("--backup-root", path.join(config.codexMaintenanceBackupDir, `${getLocalDateKey()}-${action}-${Date.now()}`));
  }
  const { stdout } = await execFileAsync("python3", args, { timeout: 300000, maxBuffer: 4 * 1024 * 1024 });
  return parseCodexMaintenanceOutput(stdout);
}

function formatCodexMaintenanceReportHtml(report) {
  const sessions = report.sessions || {};
  const archived = report.archivedSessions || {};
  const worktrees = report.worktrees || {};
  const stale = report.staleWorktrees || {};
  const logs = report.logs || {};
  const configPrune = report.configPrune || {};
  const metadata = report.metadataBloat || {};
  const nodeRows = Array.isArray(report.topNodeProcesses) ? report.topNodeProcesses : [];
  const lines = [
    b(t("maintenanceReportTitle")),
    "",
    `codexHome: ${code(report.codexHome || config.codexHome)}`,
    `sessions: ${code(cleanupCount(sessions.files ?? 0))} / ${code(formatBytes(sessions.bytes ?? 0))}`,
    `archived sessions: ${code(cleanupCount(archived.files ?? 0))} / ${code(formatBytes(archived.bytes ?? 0))}`,
    `worktrees: ${code(cleanupCount(worktrees.count ?? 0))} / ${code(formatBytes(worktrees.bytes ?? 0))}`,
    `stale worktrees: ${code(cleanupCount(stale.candidates ?? 0))} / ${code(formatBytes(stale.bytes ?? 0))}`,
    `logs: ${code(formatBytes(logs.bytes ?? 0))} / rotate ${code(`${logs.rotateThresholdMb ?? config.codexMaintenanceLogRotateMb}MB`)}`,
    `${t("cleanupMaintenanceConfigPruneCandidates")}: ${code(cleanupCount(configPrune.candidates ?? 0))}`,
    `metadata bloat: title ${code(metadata.titlesOverLimit ?? 0)} / preview ${code(metadata.previewsOverLimit ?? 0)} / 10k+ ${code(metadata.previewsOver10k ?? 0)}`
  ];
  if (nodeRows.length > 0) {
    lines.push("", b(t("nodeTop")));
    for (const item of nodeRows.slice(0, 3)) {
      lines.push(`- pid ${code(item.pid)} / ${code(`${item.mb}MB`)}`);
    }
  }
  return lines.join("\n");
}

function formatCodexMaintenanceResultHtml(result) {
  const lines = [
    b(`${t("maintenanceDone")}: ${result.action || "unknown"}`),
    "",
    `backupRoot: ${code(result.backupRoot || "none")}`,
    `backedUp: ${code(cleanupCount(Array.isArray(result.backedUp) ? result.backedUp.length : 0))}`
  ];
  if (result.configPrune) {
    lines.push(`config prune: ${t("maintenanceCandidates")}: ${code(result.configPrune.candidates)} / applied ${code(result.configPrune.applied)}`);
  }
  if (result.worktreeArchive) {
    lines.push(`worktrees: ${t("maintenanceCandidates")}: ${code(result.worktreeArchive.candidates)} / moved ${code(result.worktreeArchive.moved)} / ${code(formatBytes(result.worktreeArchive.bytes || 0))}`);
    lines.push(`manifest: ${code(result.worktreeArchive.manifest || "none")}`);
  }
  if (result.logRotate) {
    lines.push(`logs: files ${code(result.logRotate.files)} / rotated ${code(result.logRotate.rotated)} / ${code(formatBytes(result.logRotate.bytes || 0))}`);
    if (result.logRotate.skipped) lines.push(`skipped: ${code(result.logRotate.skipped)}`);
    if (result.logRotate.manifest) lines.push(`manifest: ${code(result.logRotate.manifest)}`);
  }
  if (result.sqliteMetadataRepair) {
    const repair = result.sqliteMetadataRepair;
    lines.push(`sqlite repair: ${t("maintenanceCandidates")}: ${code(repair.candidates ?? 0)} / repaired ${code(repair.repaired ?? 0)}`);
    lines.push(`limits: title ${code(repair.titleLimit ?? config.codexMaintenanceThreadTitleLimit)} / preview ${code(repair.previewLimit ?? config.codexMaintenanceThreadPreviewLimit)}`);
    if (repair.manifest) lines.push(`manifest: ${code(repair.manifest)}`);
    if (repair.restoreScript) lines.push(`restore: ${code(repair.restoreScript)}`);
    if (repair.reason) lines.push(`reason: ${code(repair.reason)}`);
  }
  return lines.join("\n");
}

async function createCurrentThreadHandoff(chatKey) {
  const chat = getChatState(chatKey);
  const cached = threadCache.get(chatKey);
  const fallbackSession = chat.threadId || cached?.id ? null : (await listRecentCodexSessions(1))[0] ?? null;
  const threadId = chat.threadId || cached?.id || fallbackSession?.id || "";
  if (!threadId) {
    throw new Error(t("handoffNoThreadError"));
  }
  return createThreadHandoff(threadId);
}

async function createThreadHandoff(threadId) {
  const sessionFile = await findCodexSessionFile(threadId);
  if (!sessionFile) {
    throw new Error(tf("handoffSessionFileNotFound", { threadId }));
  }
  const meta = await readSessionMeta(sessionFile);
  const highlights = await readSessionHighlights(sessionFile, config.codexHandoffRecentEvents);
  const targetDir = await resolveHandoffDir(meta?.cwd);
  await fs.mkdir(targetDir, { recursive: true });
  const file = path.join(targetDir, `${getLocalDateKey()}-${sanitizeHandoffFilename((meta?.cwd || "codex").split(path.sep).filter(Boolean).pop() || "codex")}-${threadId.slice(0, 8)}.md`);
  const body = renderHandoffMarkdown({
    threadId,
    sessionFile,
    meta,
    highlights,
    generatedAt: new Date().toISOString()
  });
  await fs.writeFile(file, body, "utf8");
  return { ok: true, file, threadId, cwd: meta?.cwd || "", highlights: highlights.length };
}

async function resolveHandoffDir(cwd) {
  const configured = config.codexHandoffDir;
  if (cwd && path.isAbsolute(cwd)) {
    try {
      const stat = await fs.stat(cwd);
      if (stat.isDirectory()) return path.join(cwd, "docs", "codex-handoffs");
    } catch {
      // Fall through to configured handoff dir.
    }
  }
  return configured;
}

async function readSessionHighlights(file, limit) {
  const highlights = [];
  const rl = createInterface({
    input: createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Infinity
  });
  for await (const line of rl) {
    let item;
    try {
      item = JSON.parse(line);
    } catch {
      continue;
    }
    const highlight = sessionHighlightFromItem(item);
    if (!highlight) continue;
    highlights.push(highlight);
    while (highlights.length > limit) highlights.shift();
  }
  return highlights;
}

function formatHandoffResultHtml(result) {
  return formatKeyValueHtml(t("handoffResultTitle"), [
    ["thread", result.threadId],
    ["file", result.file],
    ["cwd", result.cwd || "unknown"],
    ["highlights", cleanupCount(result.highlights)]
  ]);
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

async function handleConfirmButton(ctx, action) {
  const chatKey = getChatKey(ctx);
  if (action === "q_clear") {
    const cleared = await clearPendingTurns(chatKey);
    await editOrReplyHtml(ctx, `${b(t("clearQueueDone"))}\nCleared queued turns: ${code(cleared)}`, queueKeyboard(chatKey));
    return;
  }
  if (action === "forget") {
    if (await rejectCallbackIfActive(ctx, chatKey)) return;
    threadCache.delete(chatKey);
    delete state.chats[chatKey];
    delete state.queues[chatKey];
    pendingTurns.delete(chatKey);
    await saveState(config.stateFile, state);
    await editOrReplyHtml(ctx, t("forgetDone"), backToMainKeyboard());
    return;
  }
  if (action === "prefs_reset") {
    if (await rejectCallbackIfActive(ctx, chatKey)) return;
    const chat = getChatState(chatKey);
    chat.options = {};
    delete chat.outputSchema;
    invalidateThreadCache(chatKey);
    await saveState(config.stateFile, state);
    await editOrReplyHtml(ctx, `${b(t("prefsResetDone"))}\n\n${settingsPanelHtml(chatKey)}`, settingsKeyboard());
  }
}

async function handleUsageRefreshButton(ctx, action) {
  const chatKey = getChatKey(ctx);
  if (action === "refresh") {
    if (await rejectCallbackIfActive(ctx, chatKey)) return;
    if (getSideTurnCount(chatKey) > 0) {
      await editOrReplyHtml(ctx, `Codex side turn is already running. Use ${code("/stop")} first.`, statusKeyboard(chatKey));
      return;
    }
    if (usageRefreshes.has(chatKey)) {
      await editOrReplyHtml(ctx, `${b(t("usageRefreshRunningTitle"))}\n${t("usageRefreshRunningBody")}`, statusKeyboard(chatKey, { closable: false }));
      return;
    }
    await editOrReplyHtml(ctx, `${b(t("usageRefreshConfirmTitle"))}\n${t("usageRefreshConfirmBody")}`, withMenuCloseButton(inlineKeyboard([
      [
        { text: t("usageRefreshRun"), callback_data: "usage:refresh_confirm" },
        { text: t("cancel"), callback_data: "p:status" }
      ],
      [{ text: `← ${t("back")}`, callback_data: "p:status" }]
    ])));
    return;
  }

  if (await rejectCallbackIfActive(ctx, chatKey)) return;
  if (getSideTurnCount(chatKey) > 0) {
    await editOrReplyHtml(ctx, `Codex side turn is already running. Use ${code("/stop")} first.`, statusKeyboard(chatKey));
    return;
  }
  if (usageRefreshes.has(chatKey)) {
    await editOrReplyHtml(ctx, `${b(t("usageRefreshRunningTitle"))}\n${t("usageRefreshRunningBody")}`, statusKeyboard(chatKey, { closable: false }));
    return;
  }

  const abortController = new AbortController();
  usageRefreshes.set(chatKey, abortController);
  await editOrReplyHtml(ctx, `${b(t("usageRefreshRunningTitle"))}\n${t("usageRefreshRunningBody")}`, statusKeyboard(chatKey, { closable: false }));
  try {
    await withTimeout(refreshUsageSample(chatKey, abortController.signal), 60000, "Usage refresh timed out.");
    await editOrReplyHtml(ctx, `${b(t("usageRefreshDoneTitle"))}\n\n${formatStatusHtml(chatKey, await buildStatusDetails(chatKey))}`, statusKeyboard(chatKey));
  } catch (error) {
    abortController.abort();
    await editOrReplyHtml(ctx, `${b(t("usageRefreshFailedTitle"))}\n${code(error instanceof Error ? error.message : String(error))}`, statusKeyboard(chatKey));
  } finally {
    usageRefreshes.delete(chatKey);
  }
}

async function rejectCallbackIfActive(ctx, chatKey) {
  if (!activeTurns.has(chatKey)) return false;
  await editOrReplyHtml(ctx, `Codex turn is already running. Use ${code("/stop")} first. Plain messages can still be queued.`, statusKeyboard(chatKey));
  return true;
}

async function listCodexModels() {
  return readCodexModelCatalog(config.codexModelsCacheFile);
}

function formatModelSelectionHtml(chatKey, models) {
  const options = getEffectiveOptions(chatKey);
  const fastModels = models.filter((model) => model.fastSupported).map((model) => model.slug);
  return [
    b(t("modelSelectionTitle")),
    `Current model: ${code(options.model || "default")}`,
    `Current thinking: ${code(options.modelReasoningEffort)}`,
    `Fast service tier: ${code(options.serviceTier || "default")}`,
    "",
    t("modelSelectionDescription"),
    `${t("fastSupportedLabel")}: ${code(fastModels.length > 0 ? fastModels.join(", ") : "unknown")}`
  ].join("\n");
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

async function buildStatusDetails(chatKey) {
  const chat = getChatState(chatKey);
  const cached = threadCache.get(chatKey);
  const activeInfo = activeTurns.get(chatKey) ?? null;
  const threadId = chat.threadId || cached?.id || "";
  const fallbackSession = threadId ? null : (await listRecentCodexSessions(1))[0] ?? null;
  const usageSummary = await buildBestCodexUsageSummary(chatKey, threadId || fallbackSession?.id || "");
  return {
    threadId,
    active: Boolean(activeInfo),
    activeInfo,
    sideTurns: getSideTurnCount(chatKey),
    queued: getPendingTurns(chatKey).length,
    queuePaused: isQueuePaused(chatKey),
    queueMode: getQueueMode(chatKey),
    deliverySummary: summarizeWorkerDeliveryStatus(state.worker?.deliveries, chatKey),
    fallbackSession,
    usageSummary
  };
}

function formatStatusHtml(chatKey, details) {
  const lines = [
    b("Codex Telegram Bot"),
    `Checked: ${code(formatDateTime(new Date()))}`,
    `Thread: ${code(details.threadId || "not started")}`,
    `Active turn: ${code(details.active ? "yes" : "no")}`,
    `Side turns: ${code(details.sideTurns ?? getSideTurnCount(chatKey))}`,
    `Queue mode: ${code(details.queueMode ?? getQueueMode(chatKey))}`,
    `Queue paused: ${code(details.queuePaused ? "yes" : "no")}`,
    `Queued turns: ${code(details.queued ?? getPendingTurns(chatKey).length)}`
  ];
  lines.push(...formatPendingDeliveryLines(details.deliverySummary));
  if (details.activeInfo?.currentTurnStartedAt) {
    const elapsed = Math.max(0, (Date.now() - Date.parse(details.activeInfo.currentTurnStartedAt)) / 1000);
    lines.push(
      `Current turn: ${code(truncate(details.activeInfo.currentText?.replace(/\s+/g, " ") || "unknown", 100))}`,
      `Elapsed: ${code(formatDurationSeconds(elapsed))}`
    );
    if (details.activeInfo.lastProgress) {
      lines.push(
        `Last progress: ${code(truncate(details.activeInfo.lastProgress, 100))}`,
        `Last progress at: ${code(formatDateTime(details.activeInfo.lastProgressAt))}`
      );
    }
  }
  if (details.fallbackSession) lines.push(`Usage source: latest session ${code(details.fallbackSession.id)}`);
  if (details.usageSummary) lines.push("", pre(details.usageSummary));
  lines.push("", formatOptionsHtml(chatKey));
  return lines.join("\n");
}

async function formatRecoveryStatusHtml() {
  const [active, marker, dedupe] = await Promise.all([
    readActiveTurnSnapshots(config.botRecoveryDir),
    readRestartMarker(config.botRecoveryDir),
    readRecoveryDedupe(config.botRecoveryDir)
  ]);
  const activeSnapshots = Object.values(active.turns ?? {});
  const dedupeEntries = Object.entries(dedupe.recentRecoveryKeys ?? {});
  return formatKeyValueHtml(t("recoveryStatusTitle"), [
    ["enabled", config.botRestartRecoveryEnabled ? "yes" : "no"],
    ["active snapshots", activeSnapshots.length],
    ["restart marker", marker?.restartId || "none"],
    ["marker mode", marker?.mode || "none"],
    ["marker recoveries", marker?.recoveries?.length ?? 0],
    ["stale seconds", config.botRecoveryStaleSeconds],
    ["suspend after", config.botRecoverySuspendAfter],
    ["backfill poll", config.botRecoveryBackfillPollMs > 0 ? `${config.botRecoveryBackfillPollMs}ms` : "off"],
    ["recent recovery keys", dedupeEntries.length],
    ["last active", activeSnapshots.at(-1)?.chatKey || "none"]
  ]);
}

function formatRestartScheduledHtml(marker) {
  return formatKeyValueHtml(t("restartScheduledTitle"), [
    ["restart id", marker.restartId],
    ["active recoveries", marker.recoveries.length],
    ["delay", `${config.botRestartDelaySeconds}s`],
    ["drain timeout", `${config.botRestartDrainTimeoutSeconds}s`],
    ["exit code", marker.exitCode]
  ]);
}

function formatRestartRecoveredHtml(marker) {
  return formatKeyValueHtml(t("recoveryStartupNoticeTitle"), [
    ["restart id", marker.restartId],
    ["recoveries", marker.recoveries?.length ?? 0],
    ["mode", marker.mode || "unknown"]
  ]);
}

function formatQueueHtml(chatKey) {
  const queue = getPendingTurns(chatKey);
  const deliveryLines = formatPendingDeliveryLines(
    summarizeWorkerDeliveryStatus(state.worker?.deliveries, chatKey)
  );
  if (queue.length === 0) {
    return [
      b("Codex queue"),
      `Active turn: ${code(activeTurns.has(chatKey) ? "yes" : "no")}`,
      `Side turns: ${code(getSideTurnCount(chatKey))}`,
      `Mode: ${code(getQueueMode(chatKey))}`,
      `Paused: ${code(isQueuePaused(chatKey) ? "yes" : "no")}`,
      ...deliveryLines,
      t("queueNoTurns")
    ].join("\n");
  }

  const lines = [
    b("Codex queue"),
    `Active turn: ${code(activeTurns.has(chatKey) ? "yes" : "no")}`,
    `Side turns: ${code(getSideTurnCount(chatKey))}`,
    `Mode: ${code(getQueueMode(chatKey))}`,
    `Paused: ${code(isQueuePaused(chatKey) ? "yes" : "no")}`,
    `Queued turns: ${code(queue.length)} / ${code(runtimeValue("telegramPendingTurnsMax"))}`,
    ...deliveryLines,
    `Auto expiry: ${code(runtimeValue("telegramPendingTurnMaxAgeSeconds") <= 0 ? "off" : formatDurationSeconds(runtimeValue("telegramPendingTurnMaxAgeSeconds")))}`,
    ""
  ];
  for (const [index, turn] of queue.entries()) {
    const imageSuffix = turn.imagePaths.length > 0 ? `, images:${turn.imagePaths.length}` : "";
    const expires = runtimeValue("telegramPendingTurnMaxAgeSeconds") <= 0 ? "no expiry" : `expires ${formatDateTime(turn.expiresAt)}`;
    const kindPrefix = turn.kind === "recovery" ? "[recovery] " : "";
    lines.push(`${index + 1}. ${code(`${kindPrefix}${truncate(turn.text.replace(/\s+/g, " "), 120)}`)} (${code(turn.id)}, ${code(formatDateTime(turn.enqueuedAt))}, ${code(expires)}${imageSuffix})`);
  }
  lines.push("", t("queueButtonsHelp"));
  return lines.join("\n");
}

function formatPendingDeliveryLines(summary) {
  if (!summary || summary.count <= 0) return [];
  const deliveryKey = summary.status === "uncertain"
    ? "telegramDeliveryUncertain"
    : "telegramDeliveryPending";
  const recoveryKey = summary.recovery === "automatic_replay_disabled"
    ? "telegramDeliveryReplayDisabled"
    : summary.recovery === "manual_review_required"
      ? "telegramDeliveryManualReview"
      : "telegramDeliverySafeReplay";
  return [
    t("deliveryCodexExecutionCompleted"),
    tf(deliveryKey, { count: summary.count }),
    t(recoveryKey)
  ];
}

function formatQueueModeHtml(chatKey) {
  return [
    b("Codex queue mode"),
    `Current: ${code(getQueueMode(chatKey))}`,
    "",
    `${code("safe")}: ${t("queueModeSafeDescription")}`,
    `${code("interrupt")}: ${t("queueModeInterruptDescription")}`,
    `${code("side")}: ${t("queueModeSideDescription")}`,
    "",
    `Change with ${code("/queue_mode_safe")}, ${code("/queue_mode_interrupt")}, or ${code("/queue_mode_side")}.`
  ].join("\n");
}

function queueKeyboard(chatKey) {
  const paused = isQueuePaused(chatKey);
  const rows = [
    [
      { text: paused ? t("resumeAuto") : t("pauseAuto"), callback_data: paused ? "q:resume" : "q:pause" },
      { text: t("refresh"), callback_data: "p:queue" }
    ],
    [
      { text: "safe", callback_data: "q:mode:safe" },
      { text: "interrupt", callback_data: "q:mode:interrupt" },
      { text: "side", callback_data: "q:mode:side" }
    ]
  ];
  if (getPendingTurns(chatKey).length > 0) {
    rows.push([{ text: t("clearAll"), callback_data: "q:clear" }]);
  }
  for (const [index, turn] of getPendingTurns(chatKey).slice(0, 10).entries()) {
    const label = `#${index + 1}`;
    rows.push([
      { text: `${label} ${t("cancelItem")}`, callback_data: `queue:cancel:${turn.id}` },
      { text: `${label} ↑`, callback_data: `queue:up:${turn.id}` },
      { text: `${label} next`, callback_data: `queue:next:${turn.id}` }
    ]);
  }
  rows.push([{ text: t("main"), callback_data: "p:main" }]);
  rows.push([{ text: `← ${t("back")}`, callback_data: "p:main" }]);
  return withMenuCloseButton(inlineKeyboard(rows));
}

async function formatDoctorHtml(chatKey) {
  const [botPackage, sdkPackage, cliVersion, modelsMeta, yoloWrapper] = await Promise.all([
    readJsonFile(path.join(appRoot, "package.json")),
    readPackageJson("@openai/codex-sdk"),
    readCommandOutput(config.codexPath, ["--version"], 5000),
    readModelsCacheMeta(),
    readYoloWrapperStatus()
  ]);
  const options = getEffectiveOptions(chatKey);
  const declaredSdk = botPackage?.dependencies?.["@openai/codex-sdk"] || "unknown";
  const rows = [
    ["bot version", botPackage?.version || "unknown"],
    ["node", process.version],
    ["codex-sdk installed", sdkPackage?.version || "unknown"],
    ["codex-sdk declared", declaredSdk],
    ["codex cli", cliVersion.ok ? cliVersion.output : `error: ${cliVersion.error}`],
    ["codex path", config.codexPath],
    ["yolo wrapper", yoloWrapper],
    ["models cache", modelsMeta.status],
    ["models cache client", modelsMeta.clientVersion],
    ["models cache fetched", modelsMeta.fetchedAt],
    ["fast models", modelsMeta.fastModels],
    ["current model", options.model || "default"],
    ["current thinking", options.modelReasoningEffort],
    ["current serviceTier", options.serviceTier || "default"],
    ["worker mode", runtimeValue("codexWorkerMode")],
    ["worker socket", config.codexWorkerSocket],
    ["codex transport", runtimeValue("codexTransport")],
    ["app-server direct timeout", `${runtimeValue("codexAppServerDirectTimeoutMs")}ms`],
    ["recovery backfill poll", config.botRecoveryBackfillPollMs > 0 ? `${config.botRecoveryBackfillPollMs}ms` : "off"],
    ["upgrade smoke test", "/status -> /model -> /fast_status -> message -> /new -> /resume_last"]
  ];
  return formatKeyValueHtml("Codex doctor:", rows);
}

async function formatHealthHtml() {
  const memory = process.memoryUsage();
  const [stateCheck, backupCheck, workdirDisk, stateDisk, serviceStatus, workerServiceStatus, uploadPlan] = await Promise.all([
    checkStateReadWrite(),
    checkDirectoryWritable(config.backupDir),
    getDiskSummary(config.codexWorkdir),
    getDiskSummary(path.dirname(config.stateFile)),
    readCommandOutput("systemctl", ["--user", "is-active", "codex-telegram-bot.service"], 3000),
    readCommandOutput("systemctl", ["--user", "is-active", "codex-telegram-worker.service"], 3000),
    createUploadCleanupPlan({ dryRun: true }).catch(() => null)
  ]);
  return formatKeyValueHtml("Bot health:", [
    ["service", serviceStatus.ok ? serviceStatus.output : "unknown"],
    ["worker service", workerServiceStatus.ok ? workerServiceStatus.output : "unknown"],
    ["uptime", formatDurationSeconds(process.uptime())],
    ["memory rss", formatBytes(memory.rss)],
    ["memory heap", `${formatBytes(memory.heapUsed)} / ${formatBytes(memory.heapTotal)}`],
    ["active turns", activeTurns.size],
    ["side turns", countSideTurns()],
    ["cached threads", threadCache.size],
    ["saved chats", Object.keys(state.chats).length],
    ["live progress", runtimeValue("telegramLiveProgressEnabled") ? `${runtimeValue("telegramLiveProgressMode")}, ${config.telegramLiveProgressSource}, ${config.telegramLiveProgressDeletePolicy}, ${Math.round(runtimeValue("telegramLiveProgressIntervalMs") / 1000)}s interval` : "off"],
    ["queue expiry", runtimeValue("telegramPendingTurnMaxAgeSeconds") <= 0 ? "off" : formatDurationSeconds(runtimeValue("telegramPendingTurnMaxAgeSeconds"))],
    ["state read/write", stateCheck],
    ["backup dir write", backupCheck],
    ["workdir disk", workdirDisk],
    ["state disk", stateDisk],
    ["uploads", uploadPlan ? `${cleanupCount(uploadPlan.candidates.length + uploadPlan.preserved.length)} / ${formatBytes(uploadPlan.totalBytes)}; cleanup ${cleanupCount(uploadPlan.candidates.length)} / ${formatBytes(uploadPlan.candidateBytes)}` : "unavailable"],
    ["pending turns", countPendingTurns()],
    ["backup dir", config.backupDir],
    ["time zone", uiTimeZone()],
    ["locale", uiLocale()],
    ["snapshots", runtimeValue("snapshotEnabled") ? `on, ${runtimeValue("snapshotNotifyTime")} ${uiTimeZone()}, ${runtimeValue("snapshotRetentionDays")}d retention` : "off"]
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

function uploadCleanupKeyboard(planId) {
  return inlineKeyboard([
    [{ text: "Confirm upload cleanup", callback_data: `upload_cleanup_confirm:${planId}` }]
  ]);
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

async function readJsonFile(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function readPackageJson(packageName) {
  return readJsonFile(path.join(appRoot, "node_modules", ...packageName.split("/"), "package.json"));
}

async function readCommandOutput(command, args, timeoutMs) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { maxBuffer: 1024 * 1024, timeout: timeoutMs });
    return { ok: true, output: (stdout || stderr).trim() || "no output" };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function readModelsCacheMeta() {
  try {
    const stat = await fs.stat(config.codexModelsCacheFile);
    const parsed = JSON.parse(await fs.readFile(config.codexModelsCacheFile, "utf8"));
    const models = Array.isArray(parsed?.models) ? parsed.models : [];
    const fastModels = (await listCodexModels())
      .filter((model) => model.fastSupported)
      .map((model) => model.slug);
    return {
      status: `found, ${models.length} models, ${formatBytes(stat.size)}`,
      clientVersion: parsed?.client_version || "unknown",
      fetchedAt: parsed?.fetched_at || "unknown",
      fastModels: fastModels.length > 0 ? fastModels.join(", ") : "unknown"
    };
  } catch (error) {
    return {
      status: `missing or unreadable: ${error instanceof Error ? error.message : String(error)}`,
      clientVersion: "unknown",
      fetchedAt: "unknown",
      fastModels: "unknown"
    };
  }
}

async function readYoloWrapperStatus() {
  try {
    const body = await fs.readFile(config.codexPath, "utf8");
    if (body.includes("--dangerously-bypass-approvals-and-sandbox")) return "enabled";
    return "not detected";
  } catch {
    return "not inspected";
  }
}

async function checkStateReadWrite() {
  try {
    await fs.readFile(config.stateFile, "utf8");
    await checkDirectoryWritable(path.dirname(config.stateFile));
    return "ok";
  } catch (error) {
    return `failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function checkDirectoryWritable(dir) {
  const testFile = path.join(dir, `.write-test-${process.pid}-${Date.now()}`);
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(testFile, "ok\n", "utf8");
    await fs.rm(testFile, { force: true });
    return "ok";
  } catch (error) {
    await fs.rm(testFile, { force: true }).catch(() => {});
    return `failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function getDiskSummary(targetPath) {
  const result = await readCommandOutput("df", ["-Pk", targetPath], 3000);
  if (!result.ok) return `unknown: ${result.error}`;
  const line = result.output.split("\n").at(-1);
  const parts = line?.trim().split(/\s+/) ?? [];
  if (parts.length < 6) return "unknown";
  const available = Number(parts[3]) * 1024;
  const usedPercent = parts[4];
  return `${formatBytes(available)} free, ${usedPercent} used`;
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

function parseRequiredBoolean(value, label) {
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`${label} must be on or off.`);
}

function parseCodexAnswerFormat(value) {
  const normalized = value?.trim().toLowerCase() || "markdown";
  if (["off", "safe", "markdown"].includes(normalized)) return normalized;
  throw new Error("TELEGRAM_FORMAT_CODEX_ANSWERS must be off, safe, or markdown.");
}

function assertEnum(value, validValues, label) {
  if (!validValues.has(value)) throw new Error(`${label} must be one of: ${[...validValues].join(", ")}`);
}

function countBy(values, getKey) {
  const counts = {};
  for (const value of values) counts[getKey(value)] = (counts[getKey(value)] ?? 0) + 1;
  return counts;
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

async function readOptionalText(file) {
  try {
    return redactText(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    return `unreadable: ${error instanceof Error ? error.message : String(error)}`;
  }
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

function timestampForFilename(value) {
  return new Date(value).toISOString().replace(/[:.]/g, "-");
}

function safeFilename(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "unknown";
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
