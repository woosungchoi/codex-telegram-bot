#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadUpdateDotenv } from "../src/maintenance/update_bootstrap.js";
import { parseArgs } from "node:util";
import { readConfig } from "../src/config.js";
import { runCodexUpdate } from "../src/maintenance/update_runner.js";
import { runUpdateProcess } from "../src/maintenance/update_install.js";
import { writePrivateFileAtomic } from "../src/fs/private.js";
import { createMessageFormatter, textFor } from "../src/i18n.js";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({ options: { id: { type: "string" } }, strict: true });
if (!/^[a-f0-9-]{36}$/.test(values.id || "")) throw new Error("Update run ID required.");
const dotenv = await loadUpdateDotenv(appRoot, values.id);
const env = { ...process.env, ...dotenv.parse(await fs.readFile(path.join(appRoot, ".env"))) };
const config = readConfig(env, { appRoot });
const result = await runCodexUpdate(config, values.id);
const msg = createMessageFormatter((key) => textFor(result.language || "en", key));
let text = msg(`ui.codexUpdateResult.${result.phase}`, {
  previous: result.installation.current, version: result.target,
  error: result.error || "", rollbackError: result.rollbackError || ""
});
if (result.sdk) text += `\n\n${msg("ui.codexUpdateSdkVersions", { current: result.sdkCurrent || result.dependencies?.previousVersion || "—", target: result.phase === "succeeded" ? result.sdk.version : result.dependencies?.previousVersion || result.sdkCurrent || "—" })}`;
const runDir = path.join(config.codexUpdateDir, "runs", result.id);
const messageFile = path.join(runDir, "completion.txt");
await writePrivateFileAtomic(messageFile, text);
try {
  if (!/^[1-9]\d*$/.test(String(result.origin.messageId || "")) || !Number.isSafeInteger(Number(result.origin.messageId))) {
    throw new Error("Update panel message ID missing; no new completion message sent.");
  }
  const args = [path.join(appRoot, "scripts/send-background-notification.mjs"),
    "--requester-user-id", String(result.origin.requesterUserId || ""),
    "--authorization-version", String(result.origin.authorizationVersion || ""),
    "--chat-type", String(result.origin.chatType || ""), "--account-id", String(result.origin.accountId || ""),
    "--expected-bot-id", result.origin.botId, "--chat-id", result.origin.chatId,
    "--message-id", String(result.origin.messageId),
    "--file", messageFile, "--receipt", path.join(runDir, "notification.json")];
  if (result.origin.isForum === true) args.push("--is-forum");
  if (result.origin.threadId) args.push("--thread-id", result.origin.threadId);
  await runUpdateProcess(process.execPath, args, { timeout: 240_000, maxBuffer: 64 * 1024 });
} catch (error) {
  // Updating the CLI already has a durable outcome; a notification failure must
  // never rerun activation or send a duplicate after uncertain acceptance.
  console.error("Codex update panel edit requires review:", error.message);
}
console.log(JSON.stringify({ id: result.id, phase: result.phase }));
