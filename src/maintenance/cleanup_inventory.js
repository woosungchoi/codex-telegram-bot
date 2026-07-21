import fs from "node:fs/promises";
import path from "node:path";

export function createCleanupInventory({
  settings,
  state,
  threadCache,
  sessions,
  runProcess,
  now
}) {
  async function listCleanupSessionFiles(protectedThreadIds) {
    let files = [];
    try {
      files = await sessions.listFiles(settings.config.codexSessionsDir);
    } catch (error) {
      if (error?.code === "ENOENT") {
        return { protectedCount: protectedThreadIds.size, recentCount: 0, candidates: [] };
      }
      throw error;
    }

    const currentTime = now().getTime();
    const cutoff = currentTime
      - settings.runtimeValue("cleanupRetentionDays") * 24 * 60 * 60 * 1000;
    const candidates = [];
    let recentCount = 0;
    for (const file of files.filter((entry) => entry.endsWith(".jsonl"))) {
      const meta = await sessions.readMeta(file);
      if (!meta?.id) continue;
      const stat = await fs.stat(file);
      if (protectedThreadIds.has(meta.id)) continue;
      if (stat.mtimeMs >= cutoff) {
        recentCount += 1;
        continue;
      }
      candidates.push({
        threadId: meta.id,
        path: file,
        modifiedAt: stat.mtime.toISOString(),
        ageDays: Math.floor((currentTime - stat.mtimeMs) / 86_400_000),
        bytes: stat.size
      });
    }
    candidates.sort((left, right) => left.modifiedAt.localeCompare(right.modifiedAt));
    return { protectedCount: protectedThreadIds.size, recentCount, candidates };
  }

  async function listQuarantineDeleteCandidates() {
    let files = [];
    try {
      files = await sessions.listFiles(settings.config.cleanupQuarantineDir);
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    const currentTime = now().getTime();
    const cutoff = currentTime
      - settings.runtimeValue("cleanupQuarantineDays") * 24 * 60 * 60 * 1000;
    const candidates = [];
    for (const file of files.filter((entry) => entry.endsWith(".jsonl"))) {
      const stat = await fs.stat(file);
      const metadata = await readCleanupMetadata(file);
      const quarantinedAt = metadata?.quarantinedAt
        ? Date.parse(metadata.quarantinedAt)
        : stat.mtimeMs;
      if (Number.isNaN(quarantinedAt) || quarantinedAt >= cutoff) continue;
      const meta = await sessions.readMeta(file);
      candidates.push({
        threadId: metadata?.threadId || meta?.id || path.basename(file, ".jsonl"),
        path: file,
        originalPath: metadata?.originalPath || "",
        quarantinedAt: new Date(quarantinedAt).toISOString(),
        quarantineAgeDays: Math.floor((currentTime - quarantinedAt) / 86_400_000),
        bytes: stat.size
      });
    }
    candidates.sort((left, right) => left.quarantinedAt.localeCompare(right.quarantinedAt));
    return candidates;
  }

  async function readCleanupMetadata(file) {
    try {
      return JSON.parse(await fs.readFile(`${file}.cleanup.json`, "utf8"));
    } catch {
      return null;
    }
  }

  async function collectProtectedThreadIds() {
    const protectedThreadIds = new Set();
    for (const chat of Object.values(state.chats)) {
      if (chat?.threadId) protectedThreadIds.add(chat.threadId);
    }
    for (const thread of threadCache.values()) {
      if (thread?.id) protectedThreadIds.add(thread.id);
    }
    for (const threadId of await listRunningCodexThreadIds()) {
      protectedThreadIds.add(threadId);
    }
    return protectedThreadIds;
  }

  async function listRunningCodexThreadIds() {
    try {
      const { stdout } = await runProcess("ps", ["-eo", "args="], {
        maxBuffer: 2 * 1024 * 1024
      });
      const ids = new Set();
      const pattern = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
      for (const line of stdout.split("\n")) {
        if (!line.toLowerCase().includes("codex")) continue;
        for (const match of line.matchAll(pattern)) ids.add(match[0]);
      }
      return [...ids];
    } catch {
      return [];
    }
  }

  return {
    collectProtectedThreadIds,
    listCleanupSessionFiles,
    listQuarantineDeleteCandidates
  };
}
