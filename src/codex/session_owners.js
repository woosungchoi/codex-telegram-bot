import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

// Shared-chat policy: all currently authorized participants in one chat/topic
// share its conversations. Different chats, topics, bots and accounts do not.
function ownerPath(config, accountId, threadId) {
  if (!config.botRecoveryDir) throw new Error("Session ownership store is unavailable.");
  return path.join(config.botRecoveryDir, "session-owners", createHash("sha256")
    .update(JSON.stringify([accountId || "default", threadId])).digest("hex") + ".json");
}
function botId(config) { return String(config.telegramBotToken?.split(":")[0] || ""); }

export function ownsSession(config, chatKey, accountId, threadId) {
  if (!threadId || !chatKey || !botId(config)) return false;
  try {
    const row = JSON.parse(fs.readFileSync(ownerPath(config, accountId, threadId), "utf8"));
    return row.version === 1 && row.botId === botId(config) && row.chatKey === String(chatKey)
      && row.accountId === (accountId || "default") && row.threadId === threadId;
  } catch { return false; }
}

export function assertSessionOwner(config, chatKey, accountId, threadId) {
  if (threadId && !ownsSession(config, chatKey, accountId, threadId)) {
    throw Object.assign(new Error("Session unavailable for this conversation."), { code: "session_unavailable" });
  }
}

export function registerSessionOwner(config, chatKey, accountId, threadId) {
  if (!threadId || !chatKey || !botId(config)) throw new Error("Incomplete session ownership.");
  const file = ownerPath(config, accountId, threadId);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(file, JSON.stringify({ version: 1, botId: botId(config), chatKey: String(chatKey),
      accountId: accountId || "default", threadId, createdAt: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    assertSessionOwner(config, chatKey, accountId, threadId);
  }
}
