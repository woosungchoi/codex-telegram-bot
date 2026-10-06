import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { telegramChatKey } from "../src/telegram/context.js";
import {
  commandArgument,
  registerAdminCommands
} from "../src/telegram/admin_command_router.js";

function createFixture(config = {}) {
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
      config: { botRecoveryDir: "/tmp/recovery", ...config },
      runtimeValue: () => true,
      validQueueModes: new Set(["safe", "steer", "interrupt", "side"])
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
      getChatKey: (ctx) => ctx.chat ? telegramChatKey(ctx) : "chat",
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
  return { activeTurns, calls, commands, handlers, state };
}

test("stopping from a menu keeps previous navigation even when no turn is running", async () => {
  const { calls, handlers } = createFixture();
  await handlers.handleStopCommand({ callbackQuery: { data: "act:stop" } });
  const buttons = calls.find(([name]) => name === "reply")[3].reply_markup.inline_keyboard.flat();
  assert.ok(buttons.some((button) => button.text.startsWith("⬅️ ") && button.callback_data === "p:main"));
});

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

test("stop in a forum topic leaves other topics and General running", async () => {
  const { activeTurns, handlers } = createFixture();
  const controllers = [new AbortController(), new AbortController(), new AbortController()];
  for (const [i, key] of ["-100123:topic:40", "-100123:topic:41", "-100123"].entries()) {
    activeTurns.set(key, { abortController: controllers[i] });
  }
  await handlers.handleStopCommand({ chat: { id: -100123, type: "supergroup" }, message: { message_thread_id: 40 } });
  assert.deepEqual(controllers.map((c) => c.signal.aborted), [true, false, false]);
});

test("commandArgument accepts bot mentions and rejects a different command", () => {
  assert.equal(commandArgument("/skills@codex_bot details", "skills"), "details");
  assert.equal(commandArgument("/status", "skills"), "");
});

test("steer commands select the mode in the requesting topic without stopping work", async () => {
  for (const name of ["steer", "queue_mode_steer", "queue"]) {
    const f = createFixture();
    const abortController = new AbortController();
    f.activeTurns.set("-100123:topic:40", { abortController });
    await f.commands.get(name)({ args: "mode steer", chat: { id: -100123, type: "supergroup" }, message: { message_thread_id: 40 } });
    assert.deepEqual(f.calls[0], ["setMode", "-100123:topic:40", "steer"]);
    assert.equal(abortController.signal.aborted, false);
    assert.equal(f.calls.some(([name]) => name === "cancelWorker"), false);
  }
});

test("ops command returns localized disabled or read failure without executing an argument", async () => {
  for (const [config, expected] of [[{}, 'opsDisabled'], [{ operationalStatusFile: '/nonexistent/ops.json' }, 'opsUnavailable']]) {
    const { commands, calls } = createFixture(config);
    await commands.get('ops')({ message: { text: '/ops /etc/passwd' } });
    const reply = calls.find(([kind]) => kind === 'reply')[2];
    assert.match(reply, new RegExp(expected));
    assert.ok(!reply.includes('/etc/passwd'));
  }
});

test("ops command reads configured data and follows changed UI timezones", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ops-router-'));
  try {
    const file = path.join(dir, 'status.json');
    await writeFile(file, JSON.stringify({ schema: 1, checkedAt: '2026-10-06T00:00:00Z', services: [{ name: 'Example service', status: 'ok' }] }));
    const { commands, calls, state } = createFixture({ operationalStatusFile: file, telegramLocale: 'en-GB', telegramTimeZone: 'UTC' });
    await commands.get('ops')({});
    assert.match(calls.at(-1)[2], /00:00 \(UTC\)/);
    state.ui = { timeZone: 'Asia/Seoul', locale: 'en-GB' };
    await commands.get('ops')({});
    assert.match(calls.at(-1)[2], /09:00 \(Asia\/Seoul\)/);
    assert.match(calls.at(-1)[2], /Example service/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
