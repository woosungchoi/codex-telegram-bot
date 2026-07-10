import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { VALID_LANGUAGES } from "./i18n.js";

const defaultAppRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const CONFIG_VALID = {
  approval: new Set(["never", "on-request", "on-failure", "untrusted"]),
  sandbox: new Set(["read-only", "workspace-write", "danger-full-access"]),
  reasoning: new Set(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]),
  webSearch: new Set(["disabled", "cached", "live"]),
  codexTransport: new Set(["sdk", "app-server-direct"]),
  codexWorkerMode: new Set(["sidecar", "inline"]),
  compactStrength: new Set(["default", "light", "balanced", "aggressive"]),
  liveProgressSource: new Set(["agent", "activity", "both"]),
  liveProgressDeletePolicy: new Set(["always", "on_success", "never"])
};

export function readConfig(env = process.env, options = {}) {
  const appRoot = options.appRoot ?? defaultAppRoot;
  const cwd = options.cwd ?? process.cwd();
  const homeDir = env.HOME || cwd;
  const defaultCodexHome = path.join(homeDir, ".codex");
  const defaultCodexSessionsDir = path.join(defaultCodexHome, "sessions");
  const codexHome = env.CODEX_HOME?.trim()
    || path.dirname(env.CODEX_SESSIONS_DIR?.trim() || defaultCodexSessionsDir);
  const codexSessionsDir = env.CODEX_SESSIONS_DIR?.trim() || path.join(codexHome, "sessions");
  const stateRoot = path.join(appRoot, "state");

  const telegramBotToken = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!telegramBotToken || telegramBotToken.includes("replace_me")) {
    throw new Error("TELEGRAM_BOT_TOKEN is required. Copy .env.example to .env and set it.");
  }

  const allowedUserIds = new Set(parseTelegramIdCsv(env.ALLOWED_USER_IDS, "ALLOWED_USER_IDS"));
  if (allowedUserIds.size === 0) throw new Error("ALLOWED_USER_IDS is required.");
  const allowedChatIds = new Set(parseTelegramIdCsv(env.ALLOWED_CHAT_IDS, "ALLOWED_CHAT_IDS", { allowNegative: true }));
  const allowedThreadIds = new Set(parseTelegramIdCsv(env.ALLOWED_THREAD_IDS, "ALLOWED_THREAD_IDS"));

  const codexApprovalPolicy = env.CODEX_APPROVAL_POLICY?.trim() || "never";
  const codexSandboxMode = env.CODEX_SANDBOX_MODE?.trim() || "workspace-write";
  const codexReasoningEffort = env.CODEX_REASONING_EFFORT?.trim() || "medium";
  const codexWebSearch = env.CODEX_WEB_SEARCH?.trim() || "disabled";
  const codexTransport = env.CODEX_TRANSPORT?.trim() || "sdk";
  const codexWorkerMode = env.CODEX_WORKER_MODE?.trim() || "sidecar";
  assertEnum(codexApprovalPolicy, CONFIG_VALID.approval, "CODEX_APPROVAL_POLICY");
  assertEnum(codexSandboxMode, CONFIG_VALID.sandbox, "CODEX_SANDBOX_MODE");
  assertEnum(codexReasoningEffort, CONFIG_VALID.reasoning, "CODEX_REASONING_EFFORT");
  assertEnum(codexWebSearch, CONFIG_VALID.webSearch, "CODEX_WEB_SEARCH");
  assertEnum(codexTransport, CONFIG_VALID.codexTransport, "CODEX_TRANSPORT");
  assertEnum(codexWorkerMode, CONFIG_VALID.codexWorkerMode, "CODEX_WORKER_MODE");

  const cleanupNotifyChatIds = parseTelegramIdCsv(env.CLEANUP_NOTIFY_CHAT_IDS, "CLEANUP_NOTIFY_CHAT_IDS", { allowNegative: true });
  const workerStateDir = env.CODEX_WORKER_STATE_DIR?.trim() || path.join(stateRoot, "worker");

  return {
    telegramBotToken,
    allowedUserIds,
    allowedChatIds,
    allowedThreadIds,
    codexWorkdir: env.CODEX_WORKDIR?.trim() || homeDir,
    codexPath: env.CODEX_PATH?.trim() || "codex",
    codexTransport,
    codexAppServerDirectTimeoutMs: parseNonnegativeInteger(env.CODEX_APP_SERVER_DIRECT_TIMEOUT_MS, 5000, "CODEX_APP_SERVER_DIRECT_TIMEOUT_MS"),
    codexWorkerMode,
    codexWorkerStateDir: workerStateDir,
    codexWorkerSocket: env.CODEX_WORKER_SOCKET?.trim() || path.join(workerStateDir, "worker.sock"),
    codexWorkerConnectTimeoutMs: parseNonnegativeInteger(env.CODEX_WORKER_CONNECT_TIMEOUT_MS, 5000, "CODEX_WORKER_CONNECT_TIMEOUT_MS"),
    codexWorkerEventPollMs: parseNonnegativeInteger(env.CODEX_WORKER_EVENT_POLL_MS, 1000, "CODEX_WORKER_EVENT_POLL_MS"),
    codexModel: env.CODEX_MODEL?.trim() || "",
    codexApprovalPolicy,
    codexSandboxMode,
    codexReasoningEffort,
    codexWebSearch,
    codexPersonaPrompt: normalizeMultilineEnv(env.CODEX_PERSONA_PROMPT),
    codexNetworkAccess: parseOptionalBoolean(env.CODEX_NETWORK_ACCESS),
    codexWebSearchEnabled: parseOptionalBoolean(env.CODEX_WEB_SEARCH_ENABLED),
    codexSkipGitRepoCheck: parseOptionalBoolean(env.CODEX_SKIP_GIT_REPO_CHECK) ?? false,
    codexAdditionalDirectories: parseCsv(env.CODEX_ADDITIONAL_DIRECTORIES),
    codexBaseUrl: env.CODEX_BASE_URL?.trim() || "",
    codexApiKey: env.CODEX_API_KEY?.trim() || "",
    codexConfig: parseOptionalJson(env, "CODEX_CONFIG_JSON"),
    codexEnv: parseOptionalJson(env, "CODEX_ENV_JSON"),
    codexModelContextWindow: parseNonnegativeInteger(env.CODEX_MODEL_CONTEXT_WINDOW, 0, "CODEX_MODEL_CONTEXT_WINDOW"),
    codexAutoCompactTokenLimit: parseNonnegativeInteger(env.CODEX_AUTO_COMPACT_TOKEN_LIMIT, 0, "CODEX_AUTO_COMPACT_TOKEN_LIMIT"),
    codexToolOutputTokenLimit: parseNonnegativeInteger(env.CODEX_TOOL_OUTPUT_TOKEN_LIMIT, 0, "CODEX_TOOL_OUTPUT_TOKEN_LIMIT"),
    codexCompactStrength: parseCompactStrength(env.CODEX_COMPACT_STRENGTH),
    codexCompactPromptFile: env.CODEX_COMPACT_PROMPT_FILE?.trim() || "",
    codexContextGuardEnabled: parseOptionalBoolean(env.CODEX_CONTEXT_GUARD_ENABLED) ?? true,
    codexContextCompactThresholdPercent: parsePercentInteger(env.CODEX_CONTEXT_COMPACT_THRESHOLD_PERCENT, 75, "CODEX_CONTEXT_COMPACT_THRESHOLD_PERCENT"),
    codexContextMinRemainingTokens: parseNonnegativeInteger(env.CODEX_CONTEXT_MIN_REMAINING_TOKENS, 40000, "CODEX_CONTEXT_MIN_REMAINING_TOKENS"),
    codexModelsCacheFile: env.CODEX_MODELS_CACHE_FILE?.trim() || path.join(codexHome, "models_cache.json"),
    telegramLanguage: parseLanguage(env.TELEGRAM_LANGUAGE),
    telegramTimeZone: parseTimeZone(env.TELEGRAM_TIME_ZONE),
    telegramLocale: parseLocale(env.TELEGRAM_LOCALE),
    stateFile: env.STATE_FILE?.trim() || path.join(stateRoot, "threads.json"),
    codexHome,
    codexSessionsDir,
    codexMaintenanceScript: env.CODEX_MAINTENANCE_SCRIPT?.trim() || path.join(appRoot, "scripts", "codex_maintenance.py"),
    codexMaintenanceBackupDir: env.CODEX_MAINTENANCE_BACKUP_DIR?.trim() || path.join(stateRoot, "codex-maintenance"),
    codexMaintenanceWorktreeDays: parseNonnegativeInteger(env.CODEX_MAINTENANCE_WORKTREE_DAYS, 7, "CODEX_MAINTENANCE_WORKTREE_DAYS"),
    codexMaintenanceLogRotateMb: parseNonnegativeInteger(env.CODEX_MAINTENANCE_LOG_ROTATE_MB, 64, "CODEX_MAINTENANCE_LOG_ROTATE_MB"),
    codexMaintenanceThreadTitleLimit: parseNonnegativeInteger(env.CODEX_MAINTENANCE_THREAD_TITLE_LIMIT, 120, "CODEX_MAINTENANCE_THREAD_TITLE_LIMIT"),
    codexMaintenanceThreadPreviewLimit: parseNonnegativeInteger(env.CODEX_MAINTENANCE_THREAD_PREVIEW_LIMIT, 240, "CODEX_MAINTENANCE_THREAD_PREVIEW_LIMIT"),
    codexMaintenanceAutoSqliteRepairEnabled: parseOptionalBoolean(env.CODEX_MAINTENANCE_AUTO_SQLITE_REPAIR_ENABLED) ?? false,
    codexMaintenanceAutoHandoffEnabled: parseOptionalBoolean(env.CODEX_MAINTENANCE_AUTO_HANDOFF_ENABLED) ?? false,
    codexHandoffDir: env.CODEX_HANDOFF_DIR?.trim() || path.join(codexHome, "handoffs"),
    codexHandoffRecentEvents: parseNonnegativeInteger(env.CODEX_HANDOFF_RECENT_EVENTS, 40, "CODEX_HANDOFF_RECENT_EVENTS"),
    botRestartRecoveryEnabled: parseOptionalBoolean(env.BOT_RESTART_RECOVERY_ENABLED) ?? true,
    botRestartExitCode: parseNonnegativeInteger(env.BOT_RESTART_EXIT_CODE, 75, "BOT_RESTART_EXIT_CODE"),
    botRestartDrainTimeoutSeconds: parseNonnegativeInteger(env.BOT_RESTART_DRAIN_TIMEOUT_SECONDS, 900, "BOT_RESTART_DRAIN_TIMEOUT_SECONDS"),
    botRestartDelaySeconds: parseNonnegativeInteger(env.BOT_RESTART_DELAY_SECONDS, 3, "BOT_RESTART_DELAY_SECONDS"),
    botRecoveryDir: env.BOT_RECOVERY_DIR?.trim() || path.join(stateRoot, "recovery"),
    botRecoveryStaleSeconds: parseNonnegativeInteger(env.BOT_RECOVERY_STALE_SECONDS, 21600, "BOT_RECOVERY_STALE_SECONDS"),
    botRecoveryTurnTtlSeconds: parseNonnegativeInteger(env.BOT_RECOVERY_TURN_TTL_SECONDS, 86400, "BOT_RECOVERY_TURN_TTL_SECONDS"),
    botRecoverySuspendAfter: parseNonnegativeInteger(env.BOT_RECOVERY_SUSPEND_AFTER, 3, "BOT_RECOVERY_SUSPEND_AFTER"),
    botRecoveryBackfillPollMs: parseNonnegativeInteger(env.BOT_RECOVERY_BACKFILL_POLL_MS, 30_000, "BOT_RECOVERY_BACKFILL_POLL_MS"),
    codexStreamIdleNoticeMs: parseNonnegativeInteger(env.CODEX_STREAM_IDLE_NOTICE_MS, 120_000, "CODEX_STREAM_IDLE_NOTICE_MS"),
    codexStreamIdleAbortMs: parseNonnegativeInteger(env.CODEX_STREAM_IDLE_ABORT_MS, 900_000, "CODEX_STREAM_IDLE_ABORT_MS"),
    uploadDir: env.UPLOAD_DIR?.trim() || path.join(stateRoot, "uploads"),
    uploadRetentionDays: parseNonnegativeInteger(env.UPLOAD_RETENTION_DAYS, 7, "UPLOAD_RETENTION_DAYS"),
    uploadMaxBytes: parseNonnegativeInteger(env.UPLOAD_MAX_BYTES, 1_073_741_824, "UPLOAD_MAX_BYTES"),
    uploadCleanupEnabled: parseOptionalBoolean(env.UPLOAD_CLEANUP_ENABLED) ?? true,
    maxTelegramChars: parseNonnegativeInteger(env.MAX_TELEGRAM_CHARS, 3500, "MAX_TELEGRAM_CHARS"),
    progressEditIntervalMs: parseNonnegativeInteger(env.PROGRESS_EDIT_INTERVAL_MS, 8000, "PROGRESS_EDIT_INTERVAL_MS"),
    telegramReactionsEnabled: parseOptionalBoolean(env.TELEGRAM_REACTIONS_ENABLED) ?? true,
    telegramThinkingReaction: env.TELEGRAM_THINKING_REACTION?.trim() || "🤔",
    telegramCompleteReaction: env.TELEGRAM_COMPLETE_REACTION?.trim() || "👌",
    telegramErrorReaction: env.TELEGRAM_ERROR_REACTION?.trim() || "😢",
    telegramStoppedReaction: env.TELEGRAM_STOPPED_REACTION?.trim() || "😴",
    telegramFormatCodexAnswers: parseCodexAnswerFormat(env.TELEGRAM_FORMAT_CODEX_ANSWERS),
    telegramCompletionNoticeSeconds: parseNonnegativeInteger(env.TELEGRAM_COMPLETION_NOTICE_SECONDS, 90, "TELEGRAM_COMPLETION_NOTICE_SECONDS"),
    telegramPendingTurnsMax: parseNonnegativeInteger(env.TELEGRAM_PENDING_TURNS_MAX, 10, "TELEGRAM_PENDING_TURNS_MAX"),
    telegramPendingTurnMaxAgeSeconds: parseNonnegativeInteger(env.TELEGRAM_PENDING_TURN_MAX_AGE_SECONDS, 7200, "TELEGRAM_PENDING_TURN_MAX_AGE_SECONDS"),
    telegramLiveProgressEnabled: parseOptionalBoolean(env.TELEGRAM_LIVE_PROGRESS_ENABLED) ?? true,
    telegramLiveProgressIntervalMs: parseNonnegativeInteger(env.TELEGRAM_LIVE_PROGRESS_INTERVAL_SECONDS, 30, "TELEGRAM_LIVE_PROGRESS_INTERVAL_SECONDS") * 1000,
    telegramLiveProgressMode: env.TELEGRAM_LIVE_PROGRESS_MODE?.trim() || "brief",
    telegramLiveProgressSource: parseLiveProgressSource(env.TELEGRAM_LIVE_PROGRESS_SOURCE),
    telegramLiveProgressDeletePolicy: parseLiveProgressDeletePolicy(env.TELEGRAM_LIVE_PROGRESS_DELETE_POLICY),
    cleanupEnabled: parseOptionalBoolean(env.CLEANUP_ENABLED) ?? true,
    cleanupNotifyTime: env.CLEANUP_NOTIFY_TIME?.trim() || "09:00",
    cleanupNotifyChatIds: cleanupNotifyChatIds.length > 0 ? cleanupNotifyChatIds : [...allowedUserIds],
    cleanupRetentionDays: parseNonnegativeInteger(env.CLEANUP_RETENTION_DAYS, 14, "CLEANUP_RETENTION_DAYS"),
    cleanupQuarantineDays: parseNonnegativeInteger(env.CLEANUP_QUARANTINE_DAYS, 7, "CLEANUP_QUARANTINE_DAYS"),
    cleanupQuarantineDir: env.CLEANUP_QUARANTINE_DIR?.trim() || path.join(codexHome, "session-quarantine"),
    cleanupLogFile: env.CLEANUP_LOG_FILE?.trim() || path.join(stateRoot, "cleanup-log.jsonl"),
    cleanupArtifactDir: env.CLEANUP_ARTIFACT_DIR?.trim() || path.join(stateRoot, "cleanup-artifacts"),
    cleanupPlanTtlHours: parseNonnegativeInteger(env.CLEANUP_PLAN_TTL_HOURS, 24, "CLEANUP_PLAN_TTL_HOURS"),
    backupDir: env.BACKUP_DIR?.trim() || path.join(stateRoot, "backups"),
    snapshotEnabled: parseOptionalBoolean(env.SNAPSHOT_ENABLED) ?? true,
    snapshotNotifyTime: env.SNAPSHOT_NOTIFY_TIME?.trim() || "03:30",
    snapshotRetentionDays: parseNonnegativeInteger(env.SNAPSHOT_RETENTION_DAYS, 14, "SNAPSHOT_RETENTION_DAYS"),
    logsMaxLines: parseNonnegativeInteger(env.LOGS_MAX_LINES, 80, "LOGS_MAX_LINES")
  };
}

export function parseRequiredBoolean(value, label) {
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`${label} must be on or off.`);
}

export function parseLanguage(value) {
  const normalized = String(value || "en").trim().toLowerCase();
  return VALID_LANGUAGES.has(normalized) ? normalized : "en";
}

export function parseTimeZone(value) {
  const normalized = String(value || "UTC").trim() || "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: normalized }).format(new Date());
    return normalized;
  } catch {
    return "UTC";
  }
}

export function parseLocale(value) {
  const normalized = String(value || "en-US").trim() || "en-US";
  try {
    return Intl.getCanonicalLocales(normalized)[0] || "en-US";
  } catch {
    return "en-US";
  }
}

export function parseCodexAnswerFormat(value) {
  const normalized = value?.trim().toLowerCase() || "markdown";
  if (["off", "safe", "markdown"].includes(normalized)) return normalized;
  throw new Error("TELEGRAM_FORMAT_CODEX_ANSWERS must be off, safe, or markdown.");
}

function parseCompactStrength(value) {
  const normalized = value?.trim().toLowerCase() || "default";
  if (CONFIG_VALID.compactStrength.has(normalized)) return normalized;
  throw new Error("CODEX_COMPACT_STRENGTH must be default, light, balanced, or aggressive.");
}

function parseOptionalJson(env, envName) {
  const value = env[envName]?.trim();
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${envName} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function normalizeMultilineEnv(value) {
  return value?.trim().replaceAll("\\n", "\n") || "";
}

function parseCsv(value) {
  return (value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
}

function parseTelegramIdCsv(value, label, { allowNegative = false } = {}) {
  const entries = parseCsv(value);
  const pattern = allowNegative ? /^-?\d+$/ : /^\d+$/;
  for (const entry of entries) {
    if (!pattern.test(entry)) throw new Error(`${label} must contain numeric Telegram ids.`);
  }
  return entries;
}

function parseOptionalBoolean(value) {
  if (value == null || value.trim() === "") return undefined;
  return parseRequiredBoolean(value, "boolean");
}

function parseNonnegativeInteger(value, fallback, label) {
  const raw = String(value ?? "").trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative integer.`);
  return parsed;
}

function parsePercentInteger(value, fallback, label) {
  const parsed = parseNonnegativeInteger(value, fallback, label);
  if (parsed > 100) throw new Error(`${label} must be between 0 and 100.`);
  return parsed;
}

function parseLiveProgressSource(value) {
  const normalized = value?.trim().toLowerCase() || "agent";
  if (CONFIG_VALID.liveProgressSource.has(normalized)) return normalized;
  throw new Error("TELEGRAM_LIVE_PROGRESS_SOURCE must be agent, activity, or both.");
}

function parseLiveProgressDeletePolicy(value) {
  const normalized = value?.trim().toLowerCase().replaceAll("-", "_") || "on_success";
  if (CONFIG_VALID.liveProgressDeletePolicy.has(normalized)) return normalized;
  throw new Error("TELEGRAM_LIVE_PROGRESS_DELETE_POLICY must be always, on_success, or never.");
}

function assertEnum(value, validValues, label) {
  if (!validValues.has(value)) throw new Error(`${label} must be one of: ${[...validValues].join(", ")}`);
}
