import fs from "node:fs/promises";
import path from "node:path";
import { ensurePrivateDirectory, writePrivateFile } from "../fs/private.js";
import { serializePendingTurn } from "../queue.js";
import { safeFilename } from "../utils/text.js";
import { timestampForFilename } from "../utils/time.js";

export function createBackupController({
  settings,
  state,
  activeTurns,
  threadCache,
  chats,
  queue,
  app,
  persistence,
  clock,
  timers = { setTimeout, setInterval },
  now = () => new Date()
}) {
  function startStateSnapshotScheduler() {
    timers.setTimeout(() => {
      runDailyStateSnapshotCheck().catch((error) => {
        console.error("snapshot scheduler failed", error);
      });
    }, 10_000);
    timers.setInterval(() => {
      runDailyStateSnapshotCheck().catch((error) => {
        console.error("snapshot scheduler failed", error);
      });
    }, 60_000);
  }

  async function runDailyStateSnapshotCheck() {
    if (!settings.runtimeValue("snapshotEnabled")) return;
    const localClock = clock.getLocalClock();
    if (state.snapshots.lastDailyDate === localClock.dateKey) return;
    if (localClock.time < settings.runtimeValue("snapshotNotifyTime")) return;

    await createStateBackup("daily-snapshot");
    state.snapshots.lastDailyDate = localClock.dateKey;
    await persistence.save();
  }

  async function createStateBackup(source) {
    const config = settings.config;
    await ensurePrivateDirectory(config.backupDir);
    const createdAt = now().toISOString();
    const payload = {
      createdAt,
      source,
      app: await app.buildSummary(),
      config: app.buildConfigSummary(),
      stats: {
        chats: Object.keys(state.chats).length,
        cleanupPlans: Object.keys(state.cleanup.plans).length,
        activeTurns: activeTurns.size,
        pendingTurns: queue.countPending(),
        cachedThreads: threadCache.size
      },
      state,
      cleanupLog: await readOptionalText(config.cleanupLogFile)
    };
    const filePath = path.join(
      config.backupDir,
      `${timestampForFilename(createdAt)}-${source}.json`
    );
    await writePrivateFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await pruneOldBackups();
    const stat = await fs.stat(filePath);
    return { path: filePath, bytes: stat.size, chatCount: payload.stats.chats };
  }

  async function createChatExport(chatKey) {
    const config = settings.config;
    await ensurePrivateDirectory(config.backupDir);
    const createdAt = now().toISOString();
    const chat = chats.get(chatKey);
    const payload = {
      createdAt,
      chatKey,
      chat,
      effectiveOptions: app.redactValue(chats.getEffectiveOptions(chatKey)),
      activeTurn: activeTurns.has(chatKey),
      queuedTurns: queue.pending(chatKey).map(serializePendingTurn),
      cachedThreadId: threadCache.get(chatKey)?.id || ""
    };
    const filePath = path.join(
      config.backupDir,
      `${timestampForFilename(createdAt)}-chat-${safeFilename(chatKey)}.json`
    );
    await writePrivateFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    const stat = await fs.stat(filePath);
    return { path: filePath, bytes: stat.size };
  }

  async function pruneOldBackups() {
    const config = settings.config;
    let entries = [];
    try {
      entries = await fs.readdir(config.backupDir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    const cutoff = now().getTime()
      - settings.runtimeValue("snapshotRetentionDays") * 24 * 60 * 60 * 1000;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const filePath = path.join(config.backupDir, entry.name);
      const stat = await fs.stat(filePath);
      if (stat.mtimeMs < cutoff) await fs.rm(filePath, { force: true });
    }
  }

  return {
    createChatExport,
    createStateBackup,
    runDailyStateSnapshotCheck,
    startStateSnapshotScheduler
  };
}

async function readOptionalText(file) {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}
