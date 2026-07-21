import test from "node:test";
import assert from "node:assert/strict";
import { createCodexMaintenanceController } from "../src/maintenance/runtime_controller.js";

function createFixture() {
  const processCalls = [];
  const state = {
    maintenance: { autoHandoffEnabled: true, autoSqliteRepairEnabled: false }
  };
  const controller = createCodexMaintenanceController({
    settings: {
      config: {
        codexHandoffDir: "/tmp/handoffs",
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
      findFile: async () => null,
      listRecent: async () => [],
      readMeta: async () => null
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
