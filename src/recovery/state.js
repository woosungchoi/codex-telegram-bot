import fs from "node:fs/promises";
import path from "node:path";
import {
  ensurePrivateDirectory,
  hardenPrivateTree,
  writePrivateFileAtomic
} from "../fs/private.js";

const STATE_VERSION = 1;

export function recoveryPaths(recoveryDir) {
  return {
    dir: recoveryDir,
    activeTurns: path.join(recoveryDir, "active-turns.json"),
    journal: path.join(recoveryDir, "recovery-journal.jsonl"),
    restartMarker: path.join(recoveryDir, "restart-marker.json"),
    dedupe: path.join(recoveryDir, "recovery-dedupe.json"),
    corruptDir: path.join(recoveryDir, "corrupt")
  };
}

export async function ensureRecoveryDir(recoveryDir) {
  await ensurePrivateDirectory(recoveryDir);
}

export async function readJsonFileSafe(filePath, fallback, { quarantineDir = "" } = {}) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    if (quarantineDir) await quarantineCorruptFile(filePath, quarantineDir).catch(() => {});
    return fallback;
  }
}

export async function writeJsonFileAtomic(filePath, payload) {
  await writePrivateFileAtomic(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

export async function readActiveTurnSnapshots(recoveryDir) {
  const paths = recoveryPaths(recoveryDir);
  const payload = await readJsonFileSafe(paths.activeTurns, defaultActiveTurns(), { quarantineDir: paths.corruptDir });
  return payload && typeof payload === "object" && payload.turns && typeof payload.turns === "object"
    ? payload
    : defaultActiveTurns();
}

export async function writeActiveTurnSnapshotsAtomic(recoveryDir, payload) {
  await writeJsonFileAtomic(recoveryPaths(recoveryDir).activeTurns, normalizeActiveTurns(payload));
}

export async function upsertActiveTurnSnapshot(recoveryDir, chatKey, snapshotPatch) {
  const payload = await readActiveTurnSnapshots(recoveryDir);
  payload.turns[chatKey] = {
    ...(payload.turns[chatKey] ?? {}),
    ...snapshotPatch,
    chatKey,
    updatedAt: new Date().toISOString()
  };
  payload.updatedAt = new Date().toISOString();
  await writeActiveTurnSnapshotsAtomic(recoveryDir, payload);
  return payload.turns[chatKey];
}

export async function replaceActiveTurnSnapshot(recoveryDir, chatKey, snapshot, { now = new Date() } = {}) {
  const payload = await readActiveTurnSnapshots(recoveryDir);
  payload.turns[chatKey] = {
    ...snapshot,
    chatKey,
    updatedAt: now.toISOString()
  };
  payload.updatedAt = now.toISOString();
  await writeActiveTurnSnapshotsAtomic(recoveryDir, payload);
  return payload.turns[chatKey];
}

export async function removeActiveTurnSnapshot(recoveryDir, chatKey) {
  const payload = await readActiveTurnSnapshots(recoveryDir);
  delete payload.turns[chatKey];
  payload.updatedAt = new Date().toISOString();
  await writeActiveTurnSnapshotsAtomic(recoveryDir, payload);
}

export async function readRestartMarker(recoveryDir) {
  const paths = recoveryPaths(recoveryDir);
  return readJsonFileSafe(paths.restartMarker, null, { quarantineDir: paths.corruptDir });
}

export async function writeRestartMarkerAtomic(recoveryDir, marker) {
  await writeJsonFileAtomic(recoveryPaths(recoveryDir).restartMarker, {
    version: STATE_VERSION,
    ...marker,
    updatedAt: new Date().toISOString()
  });
}

export async function clearRestartMarker(recoveryDir) {
  await fs.rm(recoveryPaths(recoveryDir).restartMarker, { force: true });
}

export async function readRecoveryDedupe(recoveryDir) {
  const paths = recoveryPaths(recoveryDir);
  const payload = await readJsonFileSafe(paths.dedupe, defaultDedupe(), { quarantineDir: paths.corruptDir });
  return payload && typeof payload === "object" ? { ...defaultDedupe(), ...payload } : defaultDedupe();
}

export async function writeRecoveryDedupeAtomic(recoveryDir, payload) {
  await writeJsonFileAtomic(recoveryPaths(recoveryDir).dedupe, {
    ...defaultDedupe(),
    ...payload,
    updatedAt: new Date().toISOString()
  });
}

export function normalizeRestartUpdateId(updateId) {
  const value = Number(updateId);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

export function isDuplicateRestartUpdate(dedupe, updateId) {
  const value = normalizeRestartUpdateId(updateId);
  return value !== null && dedupe?.lastRestartUpdateId === value;
}

export async function rememberRestartUpdate(recoveryDir, updateId) {
  const value = normalizeRestartUpdateId(updateId);
  if (value === null) return false;
  const dedupe = await readRecoveryDedupe(recoveryDir);
  dedupe.lastRestartUpdateId = value;
  await writeRecoveryDedupeAtomic(recoveryDir, dedupe);
  return true;
}

export function recoveryKey({ chatKey, threadId = "", reason = "unknown" }) {
  return `${chatKey}:${threadId || "no-thread"}:${reason}`;
}

export function createRestartId(now = new Date()) {
  return `rst_${now.getTime().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function recoveryCandidateFromSnapshot(snapshot, reason = "self_restart") {
  if (!snapshot || snapshot.recoveryEligible === false) return null;
  return {
    chatKey: snapshot.chatKey,
    chatId: snapshot.chatId,
    messageThreadId: snapshot.messageThreadId,
    replyToMessageId: snapshot.replyToMessageId,
    originMessageId: snapshot.originMessageId,
    originUpdateId: snapshot.originUpdateId,
    queueItemId: snapshot.queueItemId,
    threadId: snapshot.threadId || "",
    reason,
    attempt: 0,
    inputPreview: snapshot.inputPreview || "",
    workingDirectory: snapshot.workingDirectory || "",
    startedAt: snapshot.startedAt || "",
    lastEventAt: snapshot.lastEventAt || "",
    workerJobId: snapshot.workerJobId || "",
    workerEventSeq: Number(snapshot.workerEventSeq || 0),
    workerMode: snapshot.workerMode || "",
    workerTransport: snapshot.workerTransport || "",
    recoveryKey: recoveryKey({ chatKey: snapshot.chatKey, threadId: snapshot.threadId || "", reason })
  };
}

export function isRecoveryCandidateStale(candidate, { now = new Date(), maxAgeSeconds = 21600 } = {}) {
  if (maxAgeSeconds <= 0) return false;
  const rawTime = candidate?.lastEventAt || candidate?.startedAt || candidate?.createdAt || "";
  const timestamp = Date.parse(rawTime);
  if (!Number.isFinite(timestamp)) return false;
  return now.getTime() - timestamp > maxAgeSeconds * 1000;
}

function defaultActiveTurns() {
  return { version: STATE_VERSION, updatedAt: "", turns: {} };
}

function defaultDedupe() {
  return { version: STATE_VERSION, updatedAt: "", lastRestartUpdateId: null, recentRecoveryKeys: {} };
}

function normalizeActiveTurns(payload) {
  return {
    version: STATE_VERSION,
    updatedAt: payload?.updatedAt || new Date().toISOString(),
    turns: payload?.turns && typeof payload.turns === "object" ? payload.turns : {}
  };
}

async function quarantineCorruptFile(filePath, quarantineDir) {
  await ensurePrivateDirectory(quarantineDir);
  const target = path.join(quarantineDir, `${path.basename(filePath)}.${Date.now()}.corrupt`);
  await fs.rename(filePath, target);
  await hardenPrivateTree(target);
}
