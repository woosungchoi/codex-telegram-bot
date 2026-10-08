import test from "node:test";
import assert from "node:assert/strict";
import { createCodexMaintenanceController } from "../src/maintenance/runtime_controller.js";

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function createFixture({ handoffDir = "/tmp/handoffs", sessionFile = null, cwd = null } = {}) {
  const processCalls = [];
  const state = {
    maintenance: { autoHandoffEnabled: true, autoSqliteRepairEnabled: false }
  };
  const controller = createCodexMaintenanceController({
    settings: {
      config: {
        codexHandoffDir: handoffDir,
        codexHandoffRecentEvents: 5,
        codexHome: "/tmp/codex",
        codexMaintenanceBackupDir: "/tmp/backups",
        codexMaintenanceLogRotateMb: 10,
        codexMaintenanceScript: "/tmp/maintenance.py",
        codexMaintenanceThreadPreviewLimit: 200,
        codexMaintenanceThreadTitleLimit: 80,
        codexMaintenanceWorktreeDays: 7
      }
    },
    state,
    threadCache: new Map(),
    chats: { get: () => ({}) },
    sessions: {
      findFile: async () => sessionFile,
      listRecent: async () => [],
      readMeta: async () => ({ cwd })
    },
    localization: {
      formatText: (key, values) => `${key}:${values.threadId}`,
      text: (key) => key
    },
    formatting: {
      bytes: (value) => `${value} B`,
      count: String,
      keyValue: (title) => title,
      localDateKey: () => "2026-07-21"
    },
    runProcess: async (...args) => {
      processCalls.push(args);
      return { stdout: JSON.stringify({ ok: true, action: "report" }) };
    },
    now: () => new Date("2026-07-21T00:00:00Z")
  });
  return { controller, processCalls };
}

test("maintenance runtime exposes state-backed automatic policy flags", () => {
  const { controller } = createFixture();
  assert.equal(controller.autoHandoffEnabled(), true);
  assert.equal(controller.autoSqliteRepairEnabled(), false);
  assert.match(controller.menuHtml(), /autoHandoff/);
});

test("maintenance runtime builds the established Python command and parses JSON", async () => {
  const { controller, processCalls } = createFixture();
  const report = await controller.readReport();
  assert.equal(report.action, "report");
  assert.equal(processCalls[0][0], "python3");
  assert.deepEqual(processCalls[0][1].slice(0, 2), ["/tmp/maintenance.py", "report"]);
});

test("current handoff reports the localized no-thread error", async () => {
  const { controller } = createFixture();
  await assert.rejects(controller.createCurrentHandoff("chat"), /handoffNoThreadError/);
});

test("repository docs symlink cannot redirect real handoff creation", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "handoff-runtime-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, "repo"), outside = path.join(root, "outside"), handoffDir = path.join(root, "private");
  await fs.mkdir(cwd); await fs.mkdir(outside); await fs.symlink(outside, path.join(cwd, "docs"));
  const sessionFile = path.join(root, "session.jsonl"); await fs.writeFile(sessionFile, "{}\n");
  const { controller } = createFixture({ handoffDir, sessionFile, cwd });
  const first = await controller.createThreadHandoff("thread"), second = await controller.createThreadHandoff("thread");
  assert.equal(path.dirname(first.file), handoffDir);
  assert.notEqual(first.file, second.file);
  assert.equal((await fs.stat(first.file)).mode & 0o777, 0o600);
  assert.deepEqual(await fs.readdir(outside), []);
});
