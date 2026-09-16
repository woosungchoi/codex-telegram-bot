import { formatDurationSeconds } from "./utils/time.js";
import { createMessageFormatter } from "./i18n.js";
export function formatCodexUsageSummary({ tokenCount, sampledAt, sourceLabel = "", now = new Date(), locale = "en-US", timeZone = "UTC", text }) {
  if (!tokenCount) return "";
  const msg = createMessageFormatter(text);

  const lines = [msg("usage.title")];
  if (sourceLabel) lines.push(msg("usage.source", { value: sourceLabel }));
  const sampleDate = toValidDate(sampledAt);
  if (sampleDate) {
    lines.push(msg("usage.sample", { time: formatDateTime(sampleDate, locale, timeZone), age: formatSampleAge(sampleDate, now, text) }));
  }

  const info = tokenCount.info;
  const usage = info?.last_token_usage || info?.usage || info?.total_token_usage;
  const totalUsage = info?.total_token_usage;
  const window = info?.model_context_window;
  const used = usage?.input_tokens ?? usage?.total_tokens;
  if (typeof used === "number" && typeof window === "number" && window > 0) {
    const left = Math.max(0, Math.round((1 - used / window) * 100));
    lines.push(msg("usage.context", { left, used: formatCompactNumber(used), window: formatCompactNumber(window) }));
  }
  const total = totalUsage?.total_tokens ?? totalUsage?.input_tokens;
  if (typeof total === "number" && total !== used) {
    lines.push(msg("usage.total", { count: formatCompactNumber(total) }));
  }

  const nowMs = toValidDate(now)?.getTime() ?? Date.now();
  const primary = tokenCount.rate_limits?.primary;
  if (primary) lines.push(msg("usage.primary", { value: formatLimitLeft(primary, nowMs, locale, timeZone, msg) }));
  const secondary = tokenCount.rate_limits?.secondary;
  if (secondary) lines.push(msg("usage.weekly", { value: formatLimitLeft(secondary, nowMs, locale, timeZone, msg) }));
  return lines.length > 1 ? lines.join("\n") : "";
}

function formatLimitLeft(limit, nowMs, locale, timeZone, msg) {
  if (typeof limit.resets_at === "number" && limit.resets_at * 1000 <= nowMs) {
    return msg("usage.stale", { time: formatDateTime(new Date(limit.resets_at * 1000), locale, timeZone) });
  }

  const usedPercent = typeof limit.used_percent === "number" ? limit.used_percent : null;
  const left = usedPercent == null ? msg("ui.unknown") : msg("usage.left", { percent: Math.max(0, Math.round(100 - usedPercent)) });
  const reset = typeof limit.resets_at === "number"
    ? msg("usage.resets", { time: formatDateTime(new Date(limit.resets_at * 1000), locale, timeZone), remaining: formatDurationUntil(limit.resets_at, nowMs, msg) })
    : "";
  return `${left}${reset}`;
}

function formatSampleAge(sampleDate, now, text) {
  const nowMs = toValidDate(now)?.getTime() ?? Date.now();
  return formatDurationSeconds(Math.max(0, (nowMs - sampleDate.getTime()) / 1000), text);
}

function formatDurationUntil(epochSeconds, nowMs, text) {
  return formatDurationSeconds(Math.max(0, (epochSeconds * 1000 - nowMs) / 1000), text);
}

function formatDateTime(value, locale, timeZone) {
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short"
  }).format(value).replace(",", "");
}

function formatCompactNumber(value) {
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`;
  if (value >= 1_000) return `${Math.round(value / 100) / 10}K`;
  return String(value);
}

function toValidDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
