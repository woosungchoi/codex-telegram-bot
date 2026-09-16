import { createMessageFormatter } from "../i18n.js";
export function timestampForFilename(value) {
  return new Date(value).toISOString().replace(/[:.]/g, "-");
}

export function formatDurationSeconds(seconds, text) {
  const msg = createMessageFormatter(text);
  let remaining = Math.floor(seconds);
  const days = Math.floor(remaining / 86400);
  remaining -= days * 86400;
  const hours = Math.floor(remaining / 3600);
  remaining -= hours * 3600;
  const minutes = Math.floor(remaining / 60);
  remaining -= minutes * 60;
  const parts = [];
  if (days > 0) parts.push(msg("units.days", { count: days }));
  if (hours > 0 || days > 0) parts.push(msg("units.hours", { count: hours }));
  if (minutes > 0 || hours > 0 || days > 0) parts.push(msg("units.minutes", { count: minutes }));
  parts.push(msg("units.seconds", { count: remaining }));
  return parts.join(" ");
}
