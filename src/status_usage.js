export function formatCodexUsageSummary({ tokenCount, sampledAt, sourceLabel = "", now = new Date(), locale = "en-US", timeZone = "UTC" }) {
  if (!tokenCount) return "";

  const lines = ["Codex usage:"];
  if (sourceLabel) lines.push(`Source: ${sourceLabel}`);
  const sampleDate = toValidDate(sampledAt);
  if (sampleDate) {
    lines.push(`Sample: ${formatDateTime(sampleDate, locale, timeZone)} (${formatSampleAge(sampleDate, now)} ago)`);
  }

  const info = tokenCount.info;
  const usage = info?.total_token_usage;
  const window = info?.model_context_window;
  const used = usage?.total_tokens ?? usage?.input_tokens;
  if (typeof used === "number" && typeof window === "number" && window > 0) {
    const left = Math.max(0, Math.round((1 - used / window) * 100));
    lines.push(`Context: ${left}% left (${formatCompactNumber(used)} used / ${formatCompactNumber(window)})`);
  }

  const nowMs = toValidDate(now)?.getTime() ?? Date.now();
  const primary = tokenCount.rate_limits?.primary;
  if (primary) lines.push(`5h limit: ${formatLimitLeft(primary, nowMs, locale, timeZone)}`);
  const secondary = tokenCount.rate_limits?.secondary;
  if (secondary) lines.push(`Weekly limit: ${formatLimitLeft(secondary, nowMs, locale, timeZone)}`);
  return lines.length > 1 ? lines.join("\n") : "";
}

function formatLimitLeft(limit, nowMs, locale, timeZone) {
  if (typeof limit.resets_at === "number" && limit.resets_at * 1000 <= nowMs) {
    return `reset passed at ${formatDateTime(new Date(limit.resets_at * 1000), locale, timeZone)}; latest sample is stale`;
  }

  const usedPercent = typeof limit.used_percent === "number" ? limit.used_percent : null;
  const left = usedPercent == null ? "unknown" : `${Math.max(0, Math.round(100 - usedPercent))}% left`;
  const reset = typeof limit.resets_at === "number"
    ? `, resets ${formatDateTime(new Date(limit.resets_at * 1000), locale, timeZone)} (${formatDurationUntil(limit.resets_at, nowMs)} left)`
    : "";
  return `${left}${reset}`;
}

function formatSampleAge(sampleDate, now) {
  const nowMs = toValidDate(now)?.getTime() ?? Date.now();
  return formatDurationSeconds(Math.max(0, (nowMs - sampleDate.getTime()) / 1000));
}

function formatDurationUntil(epochSeconds, nowMs) {
  return formatDurationSeconds(Math.max(0, (epochSeconds * 1000 - nowMs) / 1000));
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
