import { appendPrivateFile, ensurePrivateDirectory } from "../fs/private.js";
import { recoveryPaths } from "./state.js";

export async function appendRecoveryJournal(recoveryDir, event) {
  await ensurePrivateDirectory(recoveryDir);
  const payload = {
    ...event,
    at: event.at || new Date().toISOString()
  };
  await appendPrivateFile(recoveryPaths(recoveryDir).journal, `${JSON.stringify(payload)}\n`, "utf8");
}

export function summarizeStreamEvent(event) {
  const item = event?.item ?? event?.payload;
  if (!item) {
    return compactObject({
      eventType: event?.type || "unknown",
      payloadType: event?.payload?.type || ""
    });
  }
  return {
    eventType: event.type,
    itemId: item.id || "",
    itemType: item.type || "",
    status: item.status || "",
    length: textLength(item.text || item.command || item.name || item.path || item.message || item.content)
  };
}

function textLength(value) {
  if (Array.isArray(value)) return value.reduce((total, entry) => total + textLength(entry), 0);
  if (value && typeof value === "object") return textLength(value.text || value.content || "");
  return String(value || "").length;
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== "" && entry !== undefined));
}
