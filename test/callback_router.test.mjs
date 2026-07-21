import test from "node:test";
import assert from "node:assert/strict";
import { registerCallbackRoutes } from "../src/telegram/callback_router.js";

function createFixture() {
  const actions = [];
  const calls = [];
  const state = {
    chats: { chat: { options: {} } },
    queues: {},
    cleanup: { plans: {} },
    uploadCleanup: { plans: {} }
  };
  const bot = {
    action(trigger, handler) { actions.push({ trigger, handler }); }
  };
  registerCallbackRoutes({
    bot,
    settings: { config: { uploadDir: "/tmp/uploads" }, runtimeValue: () => true },
    state,
    threadCache: new Map(),
    pendingTurns: new Map(),
    usageRefreshes: new Map(),
    cleanup: {
      answerCallback: async (...args) => calls.push(["answerCleanup", ...args]),
      answerUploadCallback: async () => {},
      appendLog: async () => {},
      applyPlan: async () => ({ errors: [] }),
      confirmUploadPlan: () => ({ ok: false, reason: "missing_plan" }),
      createUploadResultLogEntry: () => ({}),
      deleteUploadCandidates: async () => ({}),
      editMessage: async (...args) => calls.push(["editCleanup", ...args]),
      editProcessingMessage: async () => {},
      editUploadMessage: async () => {},
      formatDateTime: String,
      formatIgnored: () => "ignored",
      formatResult: () => "result",
      formatUploadProcessing: () => "processing",
      formatUploadResult: () => "result"
    },
    queue: {
      clear: async () => 3,
      format: () => "queue",
      keyboard: () => ({ panel: "queue" }),
      move: async () => 1,
      pruneExpired: async () => {},
      remove: async () => 1,
      sideTurnCount: () => 0
    },
    selection: {
      handleMenuClose: async () => {},
      handleSettingsModel: async () => {},
      handleSettingsReasoning: async () => {},
      handleStandaloneCancel: async () => {},
      handleStandaloneFast: async () => {},
      handleStandaloneModel: async (...args) => calls.push(["model", ...args]),
      handleStandaloneReasoning: async () => {}
    },
    panels: { send: async () => {}, settingsHtml: () => "settings" },
    callbacks: { handleQueue: async () => {}, handleSetting: async () => {}, handleTool: async () => {} },
    skills: { isView: () => true, replyStatus: async () => {} },
    commands: {
      handleNew: async () => {},
      handleRestart: async () => {},
      handleResume: async () => {},
      handleStop: async () => {}
    },
    chats: {
      get: () => state.chats.chat,
      invalidateThreadCache: () => {},
      rejectCallbackIfActive: async () => false
    },
    usage: { refreshSample: async () => {} },
    status: { buildDetails: async () => ({}), format: () => "status", keyboard: () => ({}) },
    telegram: {
      editOrReplyHtml: async (...args) => calls.push(["edit", ...args]),
      getChatKey: () => "chat",
      replyHtml: async () => {},
      summarizeError: String
    },
    keyboards: {
      backToMain: () => ({}),
      inline: (rows) => ({ rows }),
      settings: () => ({}),
      withClose: (keyboard) => keyboard,
      withToolsBack: () => ({})
    },
    localization: { text: (key) => key },
    persistence: { save: async () => calls.push(["save"]) },
    timing: { withTimeout: (promise) => promise },
    now: () => Date.parse("2026-07-21T00:00:00Z")
  });
  return { actions, calls, state };
}

function route(actions, source) {
  return actions.find(({ trigger }) => trigger instanceof RegExp && trigger.source === source)?.handler;
}

test("callback router registers every stable callback family", () => {
  const { actions } = createFixture();
  assert.ok(actions.length >= 20);
  assert.equal(typeof route(actions, "^m:([a-f0-9]{6}):([a-zA-Z0-9._-]+|default)$"), "function");
  assert.equal(typeof route(actions, "^confirm:(q_clear|forget|prefs_reset)$"), "function");
});

test("standalone model callbacks preserve token and model arguments", async () => {
  const { actions, calls } = createFixture();
  const ctx = { match: ["m:abcdef:model", "abcdef", "model"] };
  await route(actions, "^m:([a-f0-9]{6}):([a-zA-Z0-9._-]+|default)$")(ctx);
  assert.deepEqual(calls, [["model", ctx, "abcdef", "model"]]);
});

test("queue clear confirmation edits the original panel with the cleared count", async () => {
  const { actions, calls } = createFixture();
  const ctx = { match: ["confirm:q_clear", "q_clear"], answerCbQuery: async () => {} };
  await route(actions, "^confirm:(q_clear|forget|prefs_reset)$")(ctx);
  const edit = calls.find(([name]) => name === "edit");
  assert.match(edit[2], /3/);
  assert.deepEqual(edit[3], { panel: "queue" });
});

test("expired cleanup callback removes the stale plan and persists", async () => {
  const { actions, calls, state } = createFixture();
  state.cleanup.plans.old = { id: "old", expiresAt: "2026-07-20T00:00:00Z" };
  const ctx = { match: ["cleanup:ignore:old", "ignore", "old"] };
  await route(actions, "^cleanup:(quarantine|delete|both|ignore):([a-zA-Z0-9_-]+)$")(ctx);
  assert.equal(state.cleanup.plans.old, undefined);
  assert.equal(calls.some(([name]) => name === "save"), true);
});
