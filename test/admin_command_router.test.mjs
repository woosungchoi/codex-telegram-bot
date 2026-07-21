import test from "node:test";
import assert from "node:assert/strict";
import {
  commandArgument,
  registerAdminCommands
} from "../src/telegram/admin_command_router.js";

function createFixture() {
  const commands = new Map();
  const calls = [];
  const state = {
    chats: { chat: { options: {} } },
    queues: {},
    uploadCleanup: { plans: {} }
  };
  const activeTurns = new Map();
  const bot = {
    command(name, handler) { commands.set(name, handler); }
  };
  const handlers = registerAdminCommands({
    bot,
    settings: {
      config: { botRecoveryDir: "/tmp/recovery" },
      runtimeValue: () => true,
      validQueueModes: new Set(["safe", "interrupt", "side"])
    },
    state,
    activeTurns,
    threadCache: new Map(),
    pendingTurns: new Map(),
    chats: {
      get: () => state.chats.chat,
      invalidateThreadCache: () => {},
      rejectIfActive: async () => false
    },
    panels: { send: async (...args) => calls.push(["panel", ...args]) },
    diagnostics: {
      formatConfig: () => "config",
      formatDoctor: async () => "doctor",
      formatHealth: async () => "health",
      formatLogs: async () => "logs",
      formatWhoami: () => "whoami"
    },
    skills: { replyStatus: async () => {} },
    backup: {
      createChatExport: async () => ({ path: "/tmp/chat", bytes: 1 }),
      createState: async () => ({ path: "/tmp/state", bytes: 1, chatCount: 1 })
    },
    recovery: {
      cancelWorkerJobOnce: () => calls.push(["cancelWorker"]),
      clearCompleted: async () => {},
      clearPendingTurns: async () => {},
      formatStatus: async () => "recovery",
      handleRestartCommand: async () => {},
      markActiveTurnStopped: async () => calls.push(["markStopped"]),
      scheduleStartup: async () => false
    },
    queue: {
      clearPending: async () => 2,
      format: () => "queue",
      formatMode: () => "mode",
      keyboard: () => ({}),
      pruneExpired: async () => {},
      removePending: async () => 1,
      setMode: async (...args) => calls.push(["setMode", ...args]),
      setPaused: async () => {},
      startDrain: async () => false,
      stopSideTurns: () => 0
    },
    cleanup: {
      appendLog: async () => {},
      createPlan: async () => ({ id: "cleanup" }),
      createUploadPlan: async () => ({ candidates: [] }),
      createUploadPlanLogEntry: () => ({}),
      createUploadPlanRecord: () => ({ id: "upload", createdAt: "date" }),
      formatUploadPlan: () => "upload",
      sendPlan: async () => {},
      uploadKeyboard: () => ({})
    },
    telegram: {
      editOrReplyHtml: async () => {},
      getChatKey: () => "chat",
      getCommandArgs: (ctx) => ctx.args ?? "",
      replyDocument: async () => {},
      replyHtml: async (...args) => calls.push(["reply", ...args])
    },
    localization: { text: (key) => key },
    formatting: {
      bytes: String,
      formatPrefs: () => "prefs",
      keyValue: (title) => title
    },
    persistence: { save: async () => calls.push(["save"]) }
  });
  return { activeTurns, calls, commands, handlers };
}

test("admin router registers operational and cleanup commands", () => {
  const { commands } = createFixture();
  for (const command of ["health", "restart", "queue_mode_side", "cleanup_uploads"]) {
    assert.equal(typeof commands.get(command), "function", command);
  }
});

test("queue mode shortcut persists the same mode value", async () => {
  const { calls, commands } = createFixture();
  await commands.get("queue_mode_side")({});
  assert.deepEqual(calls[0], ["setMode", "chat", "side"]);
});

test("stop command marks and aborts an active turn before clearing its queue", async () => {
  const { activeTurns, calls, handlers } = createFixture();
  const abortController = new AbortController();
  activeTurns.set("chat", { abortController, workerJobId: "job" });
  await handlers.handleStopCommand({});
  assert.equal(abortController.signal.aborted, true);
  assert.deepEqual(calls.slice(0, 2), [["markStopped"], ["cancelWorker"]]);
});

test("commandArgument accepts bot mentions and rejects a different command", () => {
  assert.equal(commandArgument("/skills@codex_bot details", "skills"), "details");
  assert.equal(commandArgument("/status", "skills"), "");
});
