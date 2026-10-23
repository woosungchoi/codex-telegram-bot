import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { assertStoredRequest } from "../authorization.js";

function directory(record, config) {
  if (!/^[a-f0-9-]{36}$/.test(record.artifactToken || "")) return null;
  const owner = createHash("sha256").update(JSON.stringify([record.botId, record.chatId,
    record.messageThreadId || 0, record.requesterUserId, record.artifactAccountId || record.accountId, record.artifactTurnId])).digest("hex");
  return path.join(config.botRecoveryDir, "turn-artifacts", owner, record.artifactToken);
}

export async function prepareTurnArtifacts(record, config) {
  assertStoredRequest(record, config);
  if (record.artifactToken) return; // recovery retains only its original capability
  record.artifactAccountId = record.accountId;
  record.artifactToken = randomUUID();
  record.artifactTurnId = record.id;
  record.artifactCreatedAt = Date.now();
  const root = directory(record, config);
  await fs.mkdir(path.dirname(root), { recursive: true, mode: 0o700 });
  await fs.mkdir(root, { mode: 0o700 });
  record.inputText += `\n\nTelegram image output for this turn: save generated images only in ${root} and reference them with [[telegram_photo:/absolute/path]]. Existing images elsewhere are not authorized attachments.`;
}

export async function turnArtifactOptions(record, config) {
  assertStoredRequest(record, config);
  const root = directory(record, config);
  if (!root || !record.artifactCreatedAt || Date.now() - record.artifactCreatedAt > 86400_000) return { allowedRoots: [] };
  if (await fs.realpath(root) !== root) throw new Error("Artifact output directory changed.");
  // Host registration, never model-supplied paths or owners. The attachment
  // validator copies bounded bytes from an opened descriptor before sending.
  const entries = await fs.readdir(root, { withFileTypes: true });
  return { allowedRoots: [root], registeredPaths: new Set(entries.filter((e) => e.isFile()).map((e) => path.join(root, e.name))) };
}
