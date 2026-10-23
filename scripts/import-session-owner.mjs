import fs from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";
import { readConfig } from "../src/config.js";
import { accountConfig } from "../src/accounts/context.js";
import { assertStoredRequest } from "../src/authorization.js";
import { registerSessionOwner } from "../src/codex/session_owners.js";
import { telegramChatKey } from "../src/telegram/context.js";

// Explicit local administrator operation; never called by startup/recovery.
const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const i = arg.indexOf("=");
  if (i < 3 || !arg.startsWith("--")) throw new Error("Use explicit --key=value arguments.");
  return [arg.slice(2, i), arg.slice(i + 1)];
}));
if (args["confirm-owner"] !== "yes" || !args["user-id"] || !args["chat-id"] || !args["session-file"]
  || !["private", "group", "supergroup"].includes(args["chat-type"])) {
  throw new Error("Required: --confirm-owner=yes --user-id=ADMIN --chat-id=CHAT --chat-type=TYPE --session-file=FILE [--topic-id=ID] [--account-id=default]. Review the session's actual owner first.");
}
const config = readConfig({ ...process.env, ...dotenv.parse(await fs.readFile(path.resolve(".env"), "utf8")) });
if (!config.codexAccountAdminUserIds.has(args["user-id"])) throw new Error("Account administrator required.");
const record = { authorizationVersion: 1, botId: config.telegramBotToken.split(":")[0], requesterUserId: args["user-id"],
  accountId: args["account-id"] || "default", chatId: args["chat-id"], chatType: args["chat-type"],
  messageThreadId: args["topic-id"] ? Number(args["topic-id"]) : undefined, isForum: args["chat-type"] === "supergroup" };
assertStoredRequest(record, config);
const root = await fs.realpath(accountConfig(config, record.accountId).codexSessionsDir);
const source = await fs.realpath(args["session-file"]);
if (!source.startsWith(`${root}${path.sep}`)) throw new Error("Session must belong to the specified account directory.");
const handle = await fs.open(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
let meta;
try {
  if (!(await handle.stat()).isFile() || !(await fs.realpath(`/proc/self/fd/${handle.fd}`)).startsWith(`${root}${path.sep}`)) throw new Error("Invalid session file.");
  const buffer = Buffer.alloc(65536);
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
  meta = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8").split("\n")[0]);
} finally { await handle.close(); }
if (meta.type !== "session_meta" || typeof meta.payload?.id !== "string" || !meta.payload.id) throw new Error("Session metadata required.");
const chatKey = telegramChatKey({ chat: { id: record.chatId, type: record.chatType }, message: { message_thread_id: record.messageThreadId } });
const audit = path.join(config.botRecoveryDir, "session-imports.jsonl");
await fs.mkdir(config.botRecoveryDir, { recursive: true, mode: 0o700 });
await fs.appendFile(audit, JSON.stringify({ at: new Date().toISOString(), action: "import_requested", actor: args["user-id"], chatKey, accountId: record.accountId, threadId: meta.payload.id }) + "\n", { mode: 0o600 });
registerSessionOwner(config, chatKey, record.accountId, meta.payload.id);
console.log("Session owner registered. Existing ownership cannot be reassigned by this command.");
