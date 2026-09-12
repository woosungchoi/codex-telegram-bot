import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

const HEAD_BYTES = 1024 * 1024;
const TAIL_BYTES = 256 * 1024;
const BOOTSTRAP = /^(?:새 Telegram Codex 세션을 시작합니다\.|Start a new Telegram Codex session\.|開始新的 Telegram Codex session。)/i;
const CONTEXT_ONLY = /^(?:#{1,6}\s+AGENTS\.md instructions\b|<turn_aborted>)/i;

function singleLine(value) {
  return String(value || "").replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim();
}

export function clipSessionText(value, length) {
  if (length <= 0) return "";
  const text = singleLine(value);
  if (text.length <= length) return text;
  let result = "";
  for (const char of text) {
    if (result.length + char.length > length - 1) break;
    result += char;
  }
  return `${result}…`;
}

// Strip only known transport wrappers; never use assistant/tool/reasoning text as a title.
export function sessionRequest(value) {
  let text = String(value || "").slice(0, 64 * 1024).trim();
  if (CONTEXT_ONLY.test(text)) return "";
  const current = text.match(/<current_message>([\s\S]*?)(?:<\/current_message>|$)/i);
  if (current) text = current[1];
  text = text.replace(/<(style_instruction|environment_context|user_instructions|INSTRUCTIONS|recommended_plugins|skills_instructions)\b[^>]*>[\s\S]*?(?:<\/\1>|$)/gi, "")
    .replace(/<replied_message>[\s\S]*?(?:<\/replied_message>|$)/gi, "")
    .replace(/^Use the following replied-to Telegram message as context\.\s*/i, "")
    .replace(/^This is a side reply while the main Telegram Codex turn continues\.\r?\nAnswer the user directly\.[^\n]*\n\s*/i, "").trim();
  if (text.startsWith("Use the built-in image generation tool, not the API-key fallback CLI.")) {
    const request = text.match(/\nRequest:\s*\n([\s\S]*)/);
    text = request?.[1]?.trim() || "";
  }
  if (BOOTSTRAP.test(text) || CONTEXT_ONLY.test(text)) return "";
  return clipSessionText(text.replace(/^#{1,6}\s+/, ""), 160);
}

export function sessionTitle(session, request = "") {
  return clipSessionText(singleLine(session.name) || session.displayTitle || request || sessionRequest(session.preview), 160);
}

function requestFromLines(text) {
  for (const line of text.split("\n")) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const p = row.payload;
    let value = "";
    if (row.type === "response_item" && p?.type === "message" && p.role === "user") {
      value = (Array.isArray(p.content) ? p.content : []).filter((v) => ["input_text", "text"].includes(v.type))
        .map((v) => typeof v.text === "string" ? v.text : "").join("\n");
    } else if (row.type === "event_msg" && p?.type === "user_message" && typeof p.message === "string") {
      value = p.message;
    }
    const request = sessionRequest(value);
    if (request) return request;
  }
  return "";
}

// Bounded, account-confined reads. Missing/oversized logs can fall back to the API preview.
export async function readSessionRequest(file, sessionsDir) {
  if (!file || !sessionsDir) return "";
  const [real, root] = await Promise.all([fs.realpath(file), fs.realpath(sessionsDir)]);
  const relative = path.relative(root, real);
  if (relative.startsWith("..") || path.isAbsolute(relative) || !real.endsWith(".jsonl")) {
    throw new Error("Session log is outside this account's session directory.");
  }
  const handle = await fs.open(real, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return "";
    const read = async (start, length) => {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, start);
      return buffer.subarray(0, bytesRead).toString("utf8");
    };
    const request = requestFromLines(await read(0, Math.min(stat.size, HEAD_BYTES)));
    if (request || stat.size <= HEAD_BYTES) return request;
    const tail = await read(stat.size - TAIL_BYTES, TAIL_BYTES);
    return requestFromLines(tail.slice(tail.indexOf("\n") + 1));
  } finally { await handle.close(); }
}

export function sessionButtonLabel(session, title, { timeZone = "UTC", showFolder = false } = {}) {
  let date = "—";
  const at = Number(session.updatedAt || session.createdAt) * 1000;
  if (Number.isFinite(at) && at > 0 && Number.isFinite(new Date(at).getTime())) {
    let formatter;
    try { formatter = new Intl.DateTimeFormat("en-US", { timeZone, month: "2-digit", day: "2-digit" }); }
    catch { formatter = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "2-digit", day: "2-digit" }); }
    date = formatter.format(new Date(at));
  }
  // UUIDv7 prefixes are timestamps, so use the random suffix to distinguish nearby sessions.
  const id = singleLine(session.id).slice(-8);
  const folder = showFolder ? `${clipSessionText(path.basename(session.cwd || "") || "/", 10)} · ` : "";
  const prefix = `${date} · ${id} · ${folder}`;
  return prefix + clipSessionText(title, 64 - prefix.length);
}
