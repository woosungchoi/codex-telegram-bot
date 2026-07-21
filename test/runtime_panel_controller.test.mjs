import test from "node:test";
import assert from "node:assert/strict";
import { createRuntimePanelController } from "../src/ui/runtime_panel_controller.js";

function createFixture() {
  const calls = [];
  const keyboards = new Proxy({
    mainPanel: (chatKey) => ({ panel: "main", chatKey }),
    previousPanelFor: (panel) => `previous:${panel}`,
    status: (chatKey) => ({ panel: "status", chatKey }),
    withClose: (keyboard) => ({ ...keyboard, close: true }),
    withPrevious: (keyboard, previous) => ({ ...keyboard, previous })
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
      text: (key) => key,
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
