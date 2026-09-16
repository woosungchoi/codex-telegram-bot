import { LocalizedError } from "../i18n.js";
import {
  CODEX_TRANSPORT_APP_SERVER_DIRECT,
  CODEX_TRANSPORT_SDK
} from "../codex/thread_factory.js";
import { writePrivateFileAtomic } from "../fs/private.js";
import { parseCleanupExecutionMode } from "../maintenance/cleanup_mode.js";
import { migrateRuntimeState, validateMutableNamespaces } from "../state/schema.js";

export async function loadRuntimeState(file, options) {
  try {
    const data = await options.readFile(file, "utf8");
    return normalizeRuntimeState(JSON.parse(data), options);
  } catch (error) {
    if (error?.code === "ENOENT") return normalizeRuntimeState({}, options);
    throw error;
  }
}

export function normalizeRuntimeState(parsed, {
  defaults,
  parseLanguage,
  parseTimeZone,
  parseLocale,
  now = Date.now()
}) {
  const stateValue = migrateRuntimeState(parsed, { now });
  return {
    ...stateValue,
    ui: {
      ...stateValue.ui,
      language: parseLanguage(stateValue.ui?.language || defaults.telegramLanguage),
      timeZone: parseTimeZone(stateValue.ui?.timeZone || defaults.telegramTimeZone),
      locale: parseLocale(stateValue.ui?.locale || defaults.telegramLocale)
    },
    runtime: stateValue.runtime && typeof stateValue.runtime === "object"
      ? sanitizeRuntimeSettings(stateValue.runtime)
      : {},
    chats: stateValue.chats && typeof stateValue.chats === "object" ? stateValue.chats : {},
    queues: stateValue.queues && typeof stateValue.queues === "object" ? stateValue.queues : {},
    cleanup: {
      ...stateValue.cleanup,
      lastDailyDate: stateValue.cleanup?.lastDailyDate ?? "",
      plans: stateValue.cleanup?.plans && typeof stateValue.cleanup.plans === "object"
        ? stateValue.cleanup.plans
        : {}
    },
    uploadCleanup: {
      ...stateValue.uploadCleanup,
      plans: stateValue.uploadCleanup?.plans && typeof stateValue.uploadCleanup.plans === "object"
        ? stateValue.uploadCleanup.plans
        : {}
    },
    maintenance: {
      ...stateValue.maintenance,
      autoSqliteRepairEnabled: typeof stateValue.maintenance?.autoSqliteRepairEnabled === "boolean"
        ? stateValue.maintenance.autoSqliteRepairEnabled
        : defaults.codexMaintenanceAutoSqliteRepairEnabled,
      autoHandoffEnabled: typeof stateValue.maintenance?.autoHandoffEnabled === "boolean"
        ? stateValue.maintenance.autoHandoffEnabled
        : defaults.codexMaintenanceAutoHandoffEnabled
    },
    worker: {
      ...stateValue.worker,
      deliveries: stateValue.worker?.deliveries && typeof stateValue.worker.deliveries === "object"
        ? stateValue.worker.deliveries
        : {}
    },
    snapshots: {
      ...stateValue.snapshots,
      lastDailyDate: stateValue.snapshots?.lastDailyDate ?? ""
    }
  };
}

export function createRuntimeSettingsController({ state, defaults, threadCache, save }) {
  function runtimeValue(key) {
    return state.runtime?.[key] ?? defaults[key];
  }

  function runtimeSeconds(key) {
    return Math.round(Number(runtimeValue(key) || 0) / 1000);
  }

  async function updateRuntimeSetting(key, rawValue) {
    if (!state.runtime || typeof state.runtime !== "object") state.runtime = {};
    const previousTransport = runtimeValue("codexTransport");
    const previousWorkerMode = runtimeValue("codexWorkerMode");
    const value = String(rawValue || "").replaceAll("_", ":");
    setRuntimeValue(state.runtime, key, value);
    if (key === "codexTransport" && runtimeValue("codexTransport") !== previousTransport) {
      threadCache.clear();
    }
    if (key === "codexWorkerMode" && runtimeValue("codexWorkerMode") !== previousWorkerMode) {
      threadCache.clear();
    }
    await save();
  }

  return { runtimeSeconds, runtimeValue, updateRuntimeSetting };
}

const pendingStateWrites = new Map();
export async function saveRuntimeState(file, value) {
  validateMutableNamespaces(value);
  const data = `${JSON.stringify(value, null, 2)}\n`;
  const pending = (pendingStateWrites.get(file) || Promise.resolve()).catch(() => {})
    .then(() => writePrivateFileAtomic(file, data));
  pendingStateWrites.set(file, pending);
  try { await pending; } finally { if (pendingStateWrites.get(file) === pending) pendingStateWrites.delete(file); }
}

export function parseRequiredBoolean(value, label) {
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new LocalizedError("errors.mustBeOnOrOff", { value1: label });
}

export function parseCodexAnswerFormat(value) {
  const normalized = value?.trim().toLowerCase() || "markdown";
  if (["off", "safe", "markdown"].includes(normalized)) return normalized;
  throw new LocalizedError("errors.invalidAnswerFormat");
}

export function setRuntimeValue(target, key, rawValue) {
  if (rawValue == null || rawValue === "default") {
    delete target[key];
    return;
  }
  const value = String(rawValue).trim();
  if ([
    "telegramReactionsEnabled",
    "telegramLiveProgressEnabled",
    "cleanupEnabled",
    "snapshotEnabled"
  ].includes(key)) {
    target[key] = parseRequiredBoolean(value, key);
  } else if (key === "telegramFormatCodexAnswers") {
    target[key] = parseCodexAnswerFormat(value);
  } else if (key === "cleanupExecutionMode") {
    target[key] = parseCleanupExecutionMode(value, key);
  } else if (key === "codexTransport") {
    if (![CODEX_TRANSPORT_SDK, CODEX_TRANSPORT_APP_SERVER_DIRECT].includes(value)) {
      throw new LocalizedError("errors.codexTransportMustBeSdkOrAppServerDirect");
    }
    target[key] = value;
  } else if (key === "codexWorkerMode") {
    if (!["sidecar", "inline"].includes(value)) {
      throw new LocalizedError("errors.codexWorkerModeMustBeSidecarOrInline");
    }
    target[key] = value;
  } else if (key === "telegramLiveProgressMode") {
    if (!["brief", "korean-brief"].includes(value)) {
      throw new LocalizedError("errors.telegramLiveProgressModeMustBeBriefOrKoreanBrief");
    }
    target[key] = value;
  } else if (key === "cleanupNotifyTime" || key === "snapshotNotifyTime") {
    target[key] = parseTimeOfDay(value);
  } else if ([
    "telegramCompletionNoticeSeconds",
    "telegramPendingTurnsMax",
    "telegramPendingTurnMaxAgeSeconds",
    "cleanupRetentionDays",
    "cleanupQuarantineDays",
    "cleanupPlanTtlHours",
    "snapshotRetentionDays",
    "logsMaxLines",
    "maxTelegramChars",
    "codexAppServerDirectTimeoutMs",
    "codexWorkerConnectTimeoutMs",
    "codexWorkerEventPollMs"
  ].includes(key)) {
    target[key] = parseStrictNonnegativeInteger(value, key);
  } else if (key === "telegramLiveProgressIntervalMs" || key === "progressEditIntervalMs") {
    const parsed = parseStrictNonnegativeInteger(value, key);
    target[key] = parsed >= 1000 ? parsed : parsed * 1000;
  } else {
    throw new LocalizedError("errors.unknownRuntimeSetting", { value1: key });
  }
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

function parseStrictNonnegativeInteger(value, label) {
  const parsed = Number(String(value ?? "").trim());
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new LocalizedError("errors.mustBeANonNegativeInteger", { value1: label });
  }
  return parsed;
}

function parseTimeOfDay(value) {
  const normalized = String(value || "").trim().replaceAll("_", ":");
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(normalized)) {
    throw new LocalizedError("errors.timeMustUseHHMM");
  }
  return normalized;
}
