import { LocalizedError, VALID_LANGUAGES } from "../i18n.js";

export const CONFIG_VALID = {
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

export function parseRequiredBoolean(value, label) {
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new LocalizedError("errors.mustBeOnOrOff", { value1: label });
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
  throw new LocalizedError("errors.invalidAnswerFormat");
}

export function parseCompactStrength(value) {
  const normalized = value?.trim().toLowerCase() || "default";
  if (CONFIG_VALID.compactStrength.has(normalized)) return normalized;
  throw new LocalizedError("errors.invalidCompactStrength");
}

export function parseOptionalJson(env, envName) {
  const value = env[envName]?.trim();
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new LocalizedError("errors.mustBeValidJSON", { value1: envName, value2: error instanceof Error ? error.message : String(error) });
  }
}

export function normalizeMultilineEnv(value) {
  return value?.trim().replaceAll("\\n", "\n") || "";
}

export function parseCsv(value) {
  return (value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
}

export function parseTelegramIdCsv(value, label, { allowNegative = false } = {}) {
  const entries = parseCsv(value);
  const pattern = allowNegative ? /^-?\d+$/ : /^\d+$/;
  for (const entry of entries) {
    if (!pattern.test(entry)) throw new LocalizedError("errors.mustContainNumericTelegramIds", { value1: label });
  }
  return entries;
}

export function parseOptionalBoolean(value) {
  if (value == null || value.trim() === "") return undefined;
  return parseRequiredBoolean(value, "boolean");
}

export function parseNonnegativeInteger(value, fallback, label) {
  const raw = String(value ?? "").trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) throw new LocalizedError("errors.mustBeANonNegativeInteger", { value1: label });
  return parsed;
}

export function parsePercentInteger(value, fallback, label) {
  const parsed = parseNonnegativeInteger(value, fallback, label);
  if (parsed > 100) throw new LocalizedError("errors.mustBeBetween0And100", { value1: label });
  return parsed;
}

export function parseLiveProgressSource(value) {
  const normalized = value?.trim().toLowerCase() || "agent";
  if (CONFIG_VALID.liveProgressSource.has(normalized)) return normalized;
  throw new LocalizedError("errors.invalidLiveProgressSource");
}

export function parseLiveProgressDeletePolicy(value) {
  const normalized = value?.trim().toLowerCase().replaceAll("-", "_") || "on_success";
  if (CONFIG_VALID.liveProgressDeletePolicy.has(normalized)) return normalized;
  throw new LocalizedError("errors.invalidLiveProgressDeletePolicy");
}

export function assertEnum(value, validValues, label) {
  if (!validValues.has(value)) throw new LocalizedError("errors.mustBeOneOf", { value1: label, value2: [...validValues].join(", ") });
}
