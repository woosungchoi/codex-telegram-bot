import { textFor } from "../src/i18n.js";
import test from "node:test";
import assert from "node:assert/strict";
import { createToolCallbackController } from "../src/ui/tool_callback_controller.js";

function createFixture({ active = false } = {}) {
  const calls = [];
  const stats = { backups: 0 };
  const state = {
    maintenance: { autoHandoffEnabled: false, autoSqliteRepairEnabled: false }
  };
  const controller = createToolCallbackController({
    settings: { config: { allowedUserIds: new Set(["7", "8"]), backupAdminUserIds: new Set(["7"]) }, runtimeValue: () => true },
    state,
    telegram: {
      editOrReplyHtml: async (...args) => calls.push(["edit", ...args]),
      getChatKey: () => "chat",
      rejectCallbackIfActive: async () => active,
      replyDocument: async (...args) => calls.push(["document", ...args]),
      replyHtml: async (...args) => calls.push(["reply", ...args])
    },
    keyboards: {
      inline: (rows) => ({ rows }),
      maintenance: () => ({ panel: "maintenance" }),
      maintenanceBusy: () => ({ panel: "busy" }),
      withClose: (keyboard) => keyboard,
      withToolsBack: () => ({ panel: "tools" })
    },
    diagnostics: {
      formatConfig: () => "config",
      formatDoctor: async () => "doctor",
      formatHealth: async () => "health",
      formatLogs: async () => "logs",
      formatWhoami: () => "whoami",
      handleAppServerStatus: async () => calls.push(["appserver"]),
      handleWorkerStatus: async () => calls.push(["worker"])
    },
    skills: { replyStatus: async () => calls.push(["skills"]) },
    backup: {
      createChatExport: async () => ({ path: "/tmp/chat.json", bytes: 3 }),
      createState: async () => { stats.backups += 1; return { path: "/tmp/state.json", bytes: 4, chatCount: 1 }; }
    },
    cleanup: { handleCommand: async () => calls.push(["cleanup"]) },
    maintenance: {
      autoHandoffEnabled: () => state.maintenance.autoHandoffEnabled,
      autoSqliteRepairEnabled: () => state.maintenance.autoSqliteRepairEnabled,
      createCurrentHandoff: async () => ({}),
      formatHandoff: () => "handoff",
      formatReport: () => "report",
      formatResult: (result) => `result:${result.action}`,
      menuHtml: () => "menu",
      readReport: async () => ({}),
      run: async (action) => {
        calls.push(["run", action]);
        return { action };
      },
      sqliteRepairConfirmHtml: () => "confirm"
    },
    persistence: { save: async () => calls.push(["save"]) },
    formatting: {
      bytes: (value) => `${value} B`,
      keyValue: (title) => title
    },
    localization: { text: (key) => textFor("en", key) }
  });
  return { calls, controller, stats };
}

test("tool callback renders diagnostics in the existing message", async () => {
  const { calls, controller } = createFixture();
  await controller.handleToolButton({}, "health");
  assert.deepEqual(calls, [["edit", {}, "health", { panel: "tools" }]]);
});

test("tool callback creates and sends a state backup", async () => {
  const { calls, controller } = createFixture();
  const ctx = { from: { id: 7 }, chat: { id: 7, type: "private" } };
  await controller.handleToolButton(ctx, "backup");
  assert.equal(calls[0][0], "reply");
  assert.deepEqual(calls[0][3], { panel: "tools" });
  assert.deepEqual(calls[1], ["document", ctx, "/tmp/state.json", "Codex Telegram Bot backup"]);
});

test("export result retains navigation back to tools", async () => {
  const { calls, controller } = createFixture();
  await controller.handleToolButton({}, "export");
  assert.deepEqual(calls[0][3], { panel: "tools" });
  assert.equal(calls[1][0], "document");
});

test("destructive maintenance actions stop when the chat is active", async () => {
  const { calls, controller } = createFixture({ active: true });
  await controller.handleToolButton({}, "codex_maintenance_config");
  assert.equal(calls.some(([name]) => name === "run"), false);
});

for (const ctx of [{}, { from: { id: 8 }, chat: { id: 8, type: "private" } }, { from: { id: 7 }, chat: { id: -1, type: "group" } }]) {
  test(`forged/stale backup button cannot create or send a backup: ${JSON.stringify(ctx)}`, async () => {
    const { calls, controller, stats } = createFixture();
    await controller.handleToolButton(ctx, "backup");
    assert.equal(stats.backups, 0);
    assert.equal(calls.some(([type]) => type === "document"), false);
  });
}
