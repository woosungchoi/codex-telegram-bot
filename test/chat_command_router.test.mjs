import test from "node:test";
import assert from "node:assert/strict";
import { registerChatCommands } from "../src/telegram/chat_command_router.js";

function createBot() {
  const commands = new Map();
  return {
    commands,
    start(handler) { commands.set("start", handler); },
    help(handler) { commands.set("help", handler); },
    command(name, handler) { commands.set(name, handler); }
  };
}

function createFixture() {
  const bot = createBot();
  const calls = [];
  const chat = { options: {} };
  const handlers = registerChatCommands({
    bot,
    settings: {
      config: {
        telegramCompleteReaction: "done",
        telegramErrorReaction: "error",
        telegramStoppedReaction: "stopped",
        telegramThinkingReaction: "thinking"
      },
      validApprovalPolicies: new Set(["never"]),
      validSandboxModes: new Set(["workspace-write"]),
      validWebSearchModes: new Set(["live"])
    },
    activeTurns: new Map(),
    threadCache: new Map(),
    chats: {
      get: () => chat,
      getEffectiveOptions: () => ({ workingDirectory: "/tmp", serviceTier: "default" }),
      invalidateThreadCache: (...args) => calls.push(["invalidate", ...args]),
      rejectIfActive: async () => false
    },
    threads: {
      remember: async () => {},
      resume: (_chatKey, id) => ({ id }),
      start: () => ({ id: "new-thread" })
    },
    sessions: { listRecent: async () => [] },
    turns: { applyPersonaPrompt: String, run: async () => ({}) },
    models: {
      formatFastStatus: () => "fast status",
      list: async () => [],
      sendStandaloneModelSelection: async () => calls.push(["modelSelection"]),
      sendStandaloneReasoningSelection: async () => calls.push(["reasoningSelection"])
    },
    options: {
      format: () => "options",
      updateCommand: async (...args) => calls.push(["updateCommand", ...args]),
      updateValue: async (...args) => calls.push(["updateValue", ...args])
    },
    panels: { helpHtml: () => "help", send: async (...args) => calls.push(["panel", ...args]) },
    status: { buildDetails: async () => ({}), format: () => "status", keyboard: () => ({}) },
    queue: { pruneExpired: async () => {} },
    telegram: {
      getChatKey: () => "chat",
      getCommandArgs: (ctx) => ctx.args ?? "",
      reactQuietly: async (...args) => calls.push(["react", ...args]),
      replyHtml: async (...args) => calls.push(["reply", ...args])
    },
    localization: { text: (key) => key },
    formatting: {
      keyValue: (title) => title,
      unique: (values) => [...new Set(values)]
    },
    filesystem: { ensureDirectory: async () => {} },
    persistence: { save: async () => calls.push(["save"]) }
  });
  return { bot, calls, chat, handlers };
}

test("chat router registers model, reasoning, and option command families", () => {
  const { bot } = createFixture();
  for (const command of [
    "model",
    "reasoning",
    "reasoning_ultra",
    "fast_status",
    "sandbox_workspace_write",
    "websearch_live",
    "stream_off"
  ]) {
    assert.equal(typeof bot.commands.get(command), "function", command);
  }
});

test("chat router preserves compact option shortcut values", async () => {
  const { bot, calls } = createFixture();
  const ctx = {};
  await bot.commands.get("sandbox_workspace_write")(ctx);
  assert.deepEqual(calls, [["updateValue", ctx, "sandboxMode", "workspace-write"]]);
});

test("fast command updates chat state, invalidates the thread, and persists", async () => {
  const { bot, calls, chat } = createFixture();
  await bot.commands.get("fast_on")({});
  assert.equal(chat.options.serviceTier, "fast");
  assert.equal(calls.some(([name]) => name === "invalidate"), true);
  assert.equal(calls.some(([name]) => name === "save"), true);
});
