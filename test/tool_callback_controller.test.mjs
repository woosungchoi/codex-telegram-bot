import test from "node:test";
import assert from "node:assert/strict";
import { createToolCallbackController } from "../src/ui/tool_callback_controller.js";

function createFixture({ active = false } = {}) {
  const calls = [];
  const state = {
    maintenance: { autoHandoffEnabled: false, autoSqliteRepairEnabled: false }
  };
  const controller = createToolCallbackController({
    settings: { config: {}, runtimeValue: () => true },
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
      createState: async () => ({ path: "/tmp/state.json", bytes: 4, chatCount: 1 })
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
    localization: { text: (key) => key }
  });
  return { calls, controller };
}

test("tool callback renders diagnostics in the existing message", async () => {
  const { calls, controller } = createFixture();
  await controller.handleToolButton({}, "health");
  assert.deepEqual(calls, [["edit", {}, "health", { panel: "tools" }]]);
});

test("tool callback creates and sends a state backup", async () => {
  const { calls, controller } = createFixture();
  await controller.handleToolButton({}, "backup");
  assert.equal(calls[0][0], "reply");
  assert.deepEqual(calls[1], ["document", {}, "/tmp/state.json", "Codex Telegram Bot backup"]);
});

test("destructive maintenance actions stop when the chat is active", async () => {
  const { calls, controller } = createFixture({ active: true });
  await controller.handleToolButton({}, "codex_maintenance_config");
  assert.equal(calls.some(([name]) => name === "run"), false);
});
