import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { textFor } from "./i18n.js";
import { b, escapeHtml } from "./telegram/html.js";

const MAX_BYTES = 128 * 1024;
const MAX_AGE_MS = 30 * 60_000;
const MAX_HTML = 3500;
const STATUS_KEYS = new Map([
  ["ok", "opsOk"], ["warning", "opsWarning"],
  ["error", "opsError"], ["unknown", "opsUnknown"]
]);
const REASON_KEYS = new Map([
  ["permission_missing", "opsPermissionMissing"], ["query_failed", "opsQueryFailed"]
]);
const defaultText = (key) => textFor("en", key);
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const boundedString = (v, max) => typeof v === "string" && v.length <= max;
const timestamp = (v) => typeof v === "string"
  && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(v)
  && Number.isFinite(Date.parse(v));

function validateSnapshot(data) {
  if (!object(data) || data.schema !== 1 || !timestamp(data.checkedAt)
    || !Array.isArray(data.services) || data.services.length > 16) {
    throw new Error("Invalid operational snapshot");
  }
  for (const service of data.services) {
    if (!object(service) || !boundedString(service.name, 100) || !service.name.trim()
      || !STATUS_KEYS.has(service.status)
      || (service.checkedAt !== undefined && !timestamp(service.checkedAt))
      || (service.message !== undefined && !boundedString(service.message, 500))
      || (service.reason !== undefined && !REASON_KEYS.has(service.reason))
      || (service.metrics !== undefined && (!Array.isArray(service.metrics) || service.metrics.length > 16))) {
      throw new Error("Invalid operational service");
    }
    for (const metric of service.metrics ?? []) {
      if (!object(metric) || !boundedString(metric.label, 100) || !metric.label.trim()
        || !(metric.value === null || boundedString(metric.value, 500)
          || (typeof metric.value === "number" && Number.isFinite(metric.value))
          || typeof metric.value === "boolean")) {
        throw new Error("Invalid operational metric");
      }
    }
  }
}

// Output is one bounded HTML message; never cut through entities or tags.
export function formatOperationalStatus(data, {
  text = defaultText, locale = "en-US", timeZone = "UTC", now = Date.now()
} = {}) {
  validateSnapshot(data);
  const dateFormat = new Intl.DateTimeFormat(locale, {
    timeZone, dateStyle: "short", timeStyle: "short"
  });
  const freshness = (at) => {
    const age = now - Date.parse(at);
    return text(age < 0 || age > MAX_AGE_MS ? "opsStale" : "opsFresh");
  };
  const date = (at) => `${dateFormat.format(new Date(at))} (${timeZone})`;
  const lines = [b(text("opsTitle")), escapeHtml(`${freshness(data.checkedAt)} · ${date(data.checkedAt)}`)];
  for (const service of data.services) {
    lines.push("", b(service.name), escapeHtml(text(STATUS_KEYS.get(service.status))));
    if (service.checkedAt) lines.push(escapeHtml(`${freshness(service.checkedAt)} · ${date(service.checkedAt)}`));
    if (service.reason) lines.push(escapeHtml(text(REASON_KEYS.get(service.reason))));
    if (service.message) lines.push(escapeHtml(service.message));
    for (const metric of service.metrics ?? []) {
      lines.push(escapeHtml(`${metric.label}: ${metric.value === null ? text("opsUnknown") : metric.value}`));
    }
  }
  if (!data.services.length) lines.push(escapeHtml(text("opsEmpty")));
  const omitted = escapeHtml(text("opsTruncated"));
  let html = "";
  for (const line of lines) {
    const next = html ? `${html}\n${line}` : line;
    if (next.length > MAX_HTML - omitted.length - 1) return `${html}\n${omitted}`;
    html = next;
  }
  return html;
}

export async function readOperationalStatus(filePath, options = {}) {
  const text = options.text ?? defaultText;
  if (!filePath) return `${b(text("opsTitle"))}\n${escapeHtml(text("opsDisabled"))}`;
  let file;
  try {
    // Nonblocking open avoids hanging on FIFOs; reject symlinks and non-files.
    file = await open(filePath, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error("Invalid snapshot file");
    // Cap actual reads too: a writer could grow the file after stat().
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await file.read(buffer, total, buffer.length - total, null);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total > MAX_BYTES) throw new Error("Snapshot is too large");
    return formatOperationalStatus(JSON.parse(buffer.subarray(0, total).toString("utf8")), options);
  } catch {
    return `${b(text("opsTitle"))}\n${escapeHtml(text("opsUnavailable"))}`;
  } finally {
    await file?.close();
  }
}
