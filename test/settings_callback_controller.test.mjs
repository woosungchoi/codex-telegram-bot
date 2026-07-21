import test from "node:test";
import assert from "node:assert/strict";
import {
  createSettingsCallbackController,
  mapSandboxValue,
  runtimeSettingKey,
  runtimeSettingValue
} from "../src/ui/settings_callback_controller.js";

function createFixture() {
  const calls = [];
  const state = { ui: {}, chats: { chat: { options: {} } } };
  const controller = createSettingsCallbackController({
    settings: {
      config: { telegramLocale: "en-US", telegramTimeZone: "UTC" },
      runtimeValue: () => 1000,
      updateRuntimeSetting: async (...args) => calls.push(["runtime", ...args]),
      validQueueModes: new Set(["safe", "interrupt", "side"]),
      saveState: async () => calls.push(["save"])
    },
    state,
    chats: {
      get: () => state.chats.chat,
      invalidateThreadCache: (...args) => calls.push(["invalidate", ...args]),
      setOption: async (...args) => calls.push(["setOption", ...args])
    },
    queue: {
      format: () => "queue",
      pruneExpired: async (...args) => calls.push(["prune", ...args]),
      setMode: async (...args) => calls.push(["setMode", ...args]),
      setPaused: async (...args) => calls.push(["setPaused", ...args]),
      startDrain: async (...args) => calls.push(["startDrain", ...args])
    },
    panels: {
      runtimeHtml: () => "runtime",
      settingsHtml: () => "settings"
    },
    keyboards: {
      inline: (rows) => ({ rows }),
      queue: () => ({ panel: "queue" }),
      runtime: () => ({ panel: "runtime" }),
      runtimeCodex: () => ({ panel: "codex" }),
      settings: () => ({ panel: "settings" }),
      withClose: (keyboard) => keyboard
    },
    telegram: {
      editOrReplyHtml: async (...args) => calls.push(["edit", ...args]),
      getChatKey: () => "chat",
      rejectCallbackIfActive: async () => false,
      summarizeError: String
    },
    localization: { text: (key) => key },
    preferences: {
      locales: [["ko", "Korean", "ko-KR"]],
      parseLanguage: String,
      parseLocale: String,
      parseTimeZone: String,
      timeZones: [["seoul", "Seoul", "Asia/Seoul"]]
    },
    diagnostics: {
      appServerDirectArgs: () => ["app-server", "--stdio"],
      readCommandOutput: async () => ({ ok: true, output: "--stdio" })
    },
    worker: {
      getClient: () => ({ status: async () => ({ status: "ok" }) })
    },
    formatting: {
      keyValue: (title) => title,
      truncate: String
    },
    commands: { register: async () => calls.push(["register"]) }
  });
  return { calls, controller, state };
}

test("settings callback maps compact values and persists one chat option", async () => {
  const { calls, controller } = createFixture();
  await controller.handleSettingButton({}, "sandbox", "ww");
  assert.deepEqual(calls.slice(0, 2), [
    ["setOption", "chat", "sandboxMode", "workspace-write"],
    ["save"]
  ]);
  assert.equal(calls.at(-1)[0], "edit");
});

test("queue callback rejects an unknown mode without mutating queue state", async () => {
  const { calls, controller } = createFixture();
  await controller.handleQueueButton({}, "mode", "unknown");
  assert.equal(calls.some(([name]) => name === "setMode"), false);
  assert.equal(calls.at(-1)[0], "edit");
});

test("runtime callback mappings preserve the existing wire format", () => {
  assert.equal(mapSandboxValue("ro"), "read-only");
  assert.equal(runtimeSettingKey("runtime_workermode"), "codexWorkerMode");
  assert.equal(runtimeSettingValue("runtime_cleanuptime", "03_30"), "03:30");
  assert.throws(() => runtimeSettingKey("runtime_unknown"), /Unknown runtime action/);
});
