import test from "node:test";
import assert from "node:assert/strict";
import { createRuntimePanelController } from "../src/ui/runtime_panel_controller.js";
import { createRuntimeKeyboardViews, modelSelectionKeyboard, reasoningSelectionKeyboard } from "../src/ui/keyboards.js";
import { textFor, SUPPORTED_LANGUAGES } from "../src/i18n.js";

function createFixture(keyboardOverrides = {}) {
  const calls = [];
  const keyboards = new Proxy({
    mainPanel: (chatKey) => ({ panel: "main", chatKey }),
    previousPanelFor: (panel) => `previous:${panel}`,
    status: (chatKey) => ({ panel: "status", chatKey }),
    withClose: (keyboard) => ({ ...keyboard, close: true }),
    withPrevious: (keyboard, previous) => ({ ...keyboard, previous }),
    ...keyboardOverrides
  }, {
    get(target, property) {
      return target[property] ?? (() => ({}));
    }
  });
  const controller = createRuntimePanelController({
    settings: {
      config: {},
      runtimeSeconds: () => 1,
      runtimeValue: () => "default"
    },
    state: { chats: { chat: {} } },
    threadCache: new Map(),
    chats: {
      effectiveModelSlug: () => "model",
      formatOptions: () => "options",
      get: () => ({}),
      getEffectiveOptions: () => ({})
    },
    queue: {
      countPending: () => 0,
      pruneExpired: async (...args) => calls.push(["prune", ...args])
    },
    status: {
      buildDetails: async () => ({ active: false }),
      formatQueue: () => "queue",
      formatStatus: () => "status"
    },
    models: {
      formatFastStatus: async () => "fast",
      formatReasoningPrompt: () => "reasoning",
      formatSelection: () => "models",
      list: async () => [],
      reasoningOptions: () => []
    },
    keyboards,
    views: new Proxy({
      renderFast: (value) => value,
      renderMain: ({ transport }) => `main:${transport}`,
      renderSettings: (value) => `settings:${value}`
    }, {
      get(target, property) {
        return target[property] ?? ((value) => String(value));
      }
    }),
    telegram: {
      editOrReplyHtml: async (...args) => calls.push(["edit", ...args]),
      getChatKey: () => "chat",
      replyHtml: async (...args) => calls.push(["reply", ...args])
    },
    localization: {
      language: () => "en",
      locale: () => "en-US",
      text: (key) => textFor("en", key),
      timeZone: () => "UTC"
    },
    formatting: {
      duration: (value) => `${value}s`,
      keyValue: (title) => title,
      optional: String
    },
    help: { html: () => "help" }
  });
  return { calls, controller };
}

test("runtime panel controller renders and replies with decorated main panel", async () => {
  const { calls, controller } = createFixture();
  await controller.sendPanel({}, "main");
  assert.deepEqual(calls, [[
    "reply",
    {},
    "main:default",
    { panel: "main", chatKey: "chat", previous: "previous:main", close: true }
  ]]);
});

test("status panel prunes its queue before editing the existing message", async () => {
  const { calls, controller } = createFixture();
  const ctx = {};
  await controller.sendPanel(ctx, "status", { edit: true });
  assert.deepEqual(calls[0], ["prune", "chat", ctx]);
  assert.deepEqual(calls[1], [
    "edit",
    ctx,
    "status",
    { panel: "status", chatKey: "chat", previous: "previous:status", close: true }
  ]);
});

test("panel helper output remains available to selection and settings callbacks", async () => {
  const { controller } = createFixture();
  assert.equal(await controller.fastPanelHtml("chat"), "fast");
  assert.equal(controller.settingsPanelHtml("chat"), "settings:options");
});

test("rendered menus and every settings subpanel have emoji labels and exactly one previous destination", async () => {
  const panels = ["main", "status", "queue", "tools", "help", "settings", "settings_model", "settings_reasoning",
    "settings_fast", "settings_sandbox", "settings_approval", "settings_web", "settings_network", "settings_stream",
    "settings_live_progress", "settings_runtime", "settings_runtime_output", "settings_runtime_queue", "settings_runtime_codex",
    "settings_runtime_cleanup", "settings_runtime_snapshot", "settings_git", "settings_paths", "settings_schema",
    "settings_language", "settings_timezone", "settings_timezone_asia", "settings_locale"];
  for (const language of SUPPORTED_LANGUAGES) {
    for (const active of [false, true]) {
      const v = createRuntimeKeyboardViews({ text: (key) => textFor(language, key), hasActiveTurn: () => active,
        sideTurnCount: () => 0, currentLanguage: () => language, currentTimeZone: () => "Asia/Seoul",
        currentLocale: () => "ko-KR", pendingTurnsFor: () => [{ id: "turn-1" }] });
      const realKeyboards = Object.fromEntries(Object.entries(v).filter(([name]) => name.endsWith("Keyboard"))
        .map(([name, build]) => [name.slice(0, -"Keyboard".length), build]));
      const { calls, controller } = createFixture({ ...realKeyboards, modelSelection: modelSelectionKeyboard,
        reasoningSelection: reasoningSelectionKeyboard, previousPanelFor: v.previousPanelFor,
        withClose: v.withMenuCloseButton, withPrevious: v.withPreviousPanelButton });
      for (const panel of panels) {
        await controller.sendPanel({}, panel, { edit: true });
        const buttons = calls.at(-1)[3].reply_markup.inline_keyboard.flat();
        const context = `${language}/${active}/${panel}`;
        assert.ok(buttons.every((button) => /^[\p{Extended_Pictographic}\p{Regional_Indicator}]/u.test(button.text)), context);
        assert.equal(buttons.filter((button) => button.callback_data === "ui:close:menu").length, 1, context);
        const back = buttons.filter((button) => button.text.startsWith("⬅️ "));
        assert.equal(back.length, panel === "main" ? 0 : 1, context);
        if (back.length) assert.equal(back[0].callback_data, `p:${v.previousPanelFor(panel)}`, context);
        assert.ok(buttons.every((button) => Buffer.byteLength(button.callback_data) <= 64), context);
      }
    }
  }
});

function createDispatchFixture() {
  const replies = [];
  const keyboards = new Proxy({
    previousPanelFor: () => null,
    settingsSelection: () => ({ source: "settingsSelection" }),
    withClose: (keyboard) => keyboard,
    withPrevious: (keyboard) => keyboard
  }, {
    get(target, property) {
      return target[property] ?? (() => ({ source: String(property) }));
    }
  });
  const views = new Proxy({}, {
    get(_target, property) {
      return () => `view:${String(property)}`;
    }
  });
  const controller = createRuntimePanelController({
    settings: {
      config: { codexPath: "codex", codexWorkerSocket: "worker.sock" },
      runtimeSeconds: () => 1,
      runtimeValue: () => "value"
    },
    state: { chats: { chat: {} } },
    threadCache: new Map(),
    chats: {
      effectiveModelSlug: () => "model",
      formatOptions: () => "options",
      get: () => ({}),
      getEffectiveOptions: () => ({})
    },
    queue: {
      countPending: () => 0,
      pruneExpired: async () => {}
    },
    status: {
      buildDetails: async () => ({}),
      formatQueue: () => "queue-status",
      formatStatus: () => "runtime-status"
    },
    models: {
      formatFastStatus: async () => "fast",
      formatReasoningPrompt: () => "reasoning-prompt",
      formatSelection: () => "model-selection",
      list: async () => [],
      reasoningOptions: () => []
    },
    keyboards,
    views,
    telegram: {
      editOrReplyHtml: async (...args) => replies.push(args),
      getChatKey: () => "chat",
      replyHtml: async (...args) => replies.push(args)
    },
    localization: {
      language: () => "en",
      locale: () => "en-US",
      text: (key) => textFor("en", key),
      timeZone: () => "UTC"
    },
    formatting: {
      duration: (value) => `${value}s`,
      keyValue: (title) => title,
      optional: String
    },
    help: { html: () => "help-html" }
  });
  return { controller, replies };
}

test("every stable panel key and fallback resolve through the public controller", async () => {
  const cases = [
    ["main", "view:renderMain", "mainPanel"],
    ["status", "runtime-status", "status"],
    ["queue", "queue-status", "queue"],
    ["settings", "view:renderSettings", "settings"],
    ["settings_model", "model-selection", "settingsSelection"],
    ["settings_reasoning", "reasoning-prompt", "settingsSelection"],
    ["settings_fast", "view:renderFast", "fast"],
    ["settings_sandbox", "view:renderSetting", "sandbox"],
    ["settings_approval", "view:renderSetting", "approval"],
    ["settings_web", "view:renderSetting", "webSearch"],
    ["settings_network", "view:renderSetting", "booleanOption"],
    ["settings_stream", "view:renderSetting", "booleanOption"],
    ["settings_live_progress", "view:renderLiveProgress", "liveProgress"],
    ["settings_runtime", "view:renderRuntime", "runtime"],
    ["settings_runtime_output", "Output runtime:", "runtimeOutput"],
    ["settings_runtime_queue", "Queue runtime:", "runtimeQueue"],
    ["settings_runtime_codex", "Codex runtime:", "runtimeCodex"],
    ["settings_runtime_cleanup", "Cleanup runtime:", "runtimeCleanup"],
    ["settings_runtime_snapshot", "Snapshot runtime:", "runtimeSnapshot"],
    ["settings_git", "view:renderSetting", "booleanOption"],
    ["settings_paths", "view:renderPaths", "paths"],
    ["settings_schema", "view:renderSchema", "schema"],
    ["settings_language", "view:renderSetting", "language"],
    ["settings_timezone", "view:renderSetting", "timeZone"],
    ["settings_timezone_utc", "view:renderTimeZoneGroup", "timeZoneGroup"],
    ["settings_locale", "view:renderSetting", "locale"],
    ["tools", "view:renderTools", "tools"],
    ["help", "help-html", "backToMain"],
    ["unknown", "view:renderMain", "mainPanel"]
  ];

  for (const [panel, expectedHtml, expectedKeyboard] of cases) {
    const { controller, replies } = createDispatchFixture();
    await controller.sendPanel({}, panel);
    assert.equal(replies.length, 1, panel);
    assert.equal(replies[0][1], expectedHtml, panel);
    assert.equal(replies[0][2].source, expectedKeyboard, panel);
  }
});
