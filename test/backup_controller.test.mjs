import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBackupController } from "../src/maintenance/backup_controller.js";

async function createFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-backup-controller-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const state = {
    chats: { chat: { options: {} } },
    cleanup: { plans: {} },
    snapshots: { lastDailyDate: "" }
  };
  const saves = [];
  const controller = createBackupController({
    settings: {
      config: {
        backupDir: path.join(root, "backups"),
        cleanupLogFile: path.join(root, "missing.log")
      },
      runtimeValue(key) {
        if (key === "snapshotEnabled") return true;
        if (key === "snapshotNotifyTime") return "03:00";
        if (key === "snapshotRetentionDays") return 30;
        return undefined;
      }
    },
    state,
    activeTurns: new Map(),
    threadCache: new Map(),
    chats: {
      get: () => state.chats.chat,
      getEffectiveOptions: () => ({ apiKey: "secret" })
    },
    queue: {
      countPending: () => 0,
      pending: () => []
    },
    app: {
      buildConfigSummary: () => ({ safe: true }),
      buildSummary: async () => ({ version: "1.2.8" }),
      redactValue: () => ({ apiKey: "[redacted]" })
    },
    persistence: { save: async () => saves.push("save") },
    clock: { getLocalClock: () => ({ dateKey: "2026-07-21", time: "04:00" }) },
    timers: { setTimeout() {}, setInterval() {} },
    now: () => new Date("2026-07-21T00:00:00Z")
  });
  return { controller, saves, state };
}

test("backup controller writes a private state snapshot with runtime statistics", async (t) => {
  const { controller } = await createFixture(t);
  const result = await controller.createStateBackup("manual");
  const parsed = JSON.parse(await fs.readFile(result.path, "utf8"));
  const stat = await fs.stat(result.path);
  assert.equal(parsed.source, "manual");
  assert.equal(parsed.stats.chats, 1);
  assert.equal(stat.mode & 0o777, 0o600);
});

test("daily snapshot runs once after the configured local time", async (t) => {
  const { controller, saves, state } = await createFixture(t);
  await controller.runDailyStateSnapshotCheck();
  assert.equal(state.snapshots.lastDailyDate, "2026-07-21");
  assert.deepEqual(saves, ["save"]);
  await controller.runDailyStateSnapshotCheck();
  assert.deepEqual(saves, ["save"]);
});
