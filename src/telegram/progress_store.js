import fs from "node:fs/promises";
import { writePrivateFileAtomic } from "../fs/private.js";

// Recovery and worker retries have new job IDs but own the same progress messages.
export function progressTurnId(turn = {}) {
  return String(turn.progressTurnId || turn.recovery?.progressTurnId
    || turn.recovery?.queueItemId || turn.queueItemId || turn.id || "");
}

export async function loadProgressMessageStore(file, { now = Date.now } = {}) {
  let entries = {};
  try {
    entries = JSON.parse(await fs.readFile(file, "utf8")).turns || {};
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  let writes = Promise.resolve();

  function key(progress) {
    return progress?.chatKey && progress?.progressTurnId
      ? JSON.stringify([String(progress.chatKey), String(progress.progressTurnId)]) : "";
  }

  function persist() {
    // Serialize this file's writes independently of chat/worker state snapshots.
    const write = writes.catch(() => {}).then(() => writePrivateFileAtomic(
      file, `${JSON.stringify({ version: 1, turns: entries }, null, 2)}\n`
    ));
    writes = write;
    return write;
  }

  function getRefs(progress) {
    return (entries[key(progress)]?.messageRefs || []).map((ref) => ({ ...ref }));
  }

  async function track(progress, ref) {
    const id = key(progress);
    if (!id) return;
    const entry = entries[id] ||= {
      chatKey: progress.chatKey,
      progressTurnId: progress.progressTurnId,
      messageRefs: [],
      cleanupPending: false
    };
    if (!entry.messageRefs.some((existing) => sameRef(existing, ref))) {
      entry.messageRefs.push(ref);
    }
    entry.updatedAt = now();
    entry.cleanupPending = false;
    await prune();
    await persist();
  }

  async function beginCleanup(progress) {
    const entry = entries[key(progress)];
    if (!entry) return;
    entry.cleanupPending = true;
    await persist();
  }

  async function remove(progress, removed) {
    const id = key(progress);
    const entry = entries[id];
    if (!entry) return;
    entry.messageRefs = entry.messageRefs.filter((ref) => !removed.some((item) => sameRef(item, ref)));
    if (entry.messageRefs.length === 0) delete entries[id];
    await persist();
  }

  function pending() {
    return Object.values(entries).filter((entry) => entry.cleanupPending)
      .map((entry) => ({ ...entry, messageRefs: getRefs(entry) }));
  }

  async function prune() {
    // Drop expired bookkeeping without attempting to delete retained messages.
    const cutoff = now() - 48 * 60 * 60 * 1000;
    let changed = false;
    for (const [id, entry] of Object.entries(entries)) {
      if (Number(entry.updatedAt || 0) >= cutoff) continue;
      delete entries[id];
      changed = true;
    }
    if (changed) await persist();
  }

  return { getRefs, track, beginCleanup, remove, pending, prune };
}

export function sameRef(left, right) {
  return String(left.chatId) === String(right.chatId) && left.messageId === right.messageId;
}
