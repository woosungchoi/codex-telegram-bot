import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as waitForImmediate } from "node:timers/promises";
import { createTurnRuntimeController } from "../src/codex/turn_controller.js";

function createHarness({ queueMode = "safe", workerEnabled = false } = {}) {
  const activeTurns = new Map();
  const pending = new Map();
  const calls = [];
  const replies = [];
  const ctx = {
    chat: { id: 42 },
    from: { id: 7 },
    sendChatAction: async (action) => calls.push(["chat-action", action])
  };
  const record = (name, value) => async (...args) => {
    calls.push([name, ...args]);
    return value;
  };
  const controller = createTurnRuntimeController({
    settings: {
      maxPendingTurns: () => 5,
      pendingTurnMaxAgeSeconds: () => 60,
      thinkingReaction: "thinking",
      stoppedReaction: "stopped",
      errorReaction: "error",
      completeReaction: "complete"
    },
    activeTurns,
    queue: {
      createItemId: () => "turn-1",
      dequeue: async (chatKey) => pending.get(chatKey)?.shift() ?? null,
      enqueue: async (chatKey, turn) => {
        const turns = pending.get(chatKey) ?? [];
        turns.push(turn);
        pending.set(chatKey, turns);
        return { ok: true, position: turns.length };
      },
      enqueueFront: async (chatKey, turn) => {
        const turns = pending.get(chatKey) ?? [];
        turns.unshift(turn);
        pending.set(chatKey, turns);
        return { ok: true, position: 1 };
      },
      getMode: () => queueMode,
      getPending: (chatKey) => pending.get(chatKey) ?? [],
      hasPendingFinalDelivery: () => false,
      isPaused: () => false,
      pruneExpired: record("prune")
    },
    lifecycle: {
      isRecoveryActive: () => false,
      isRestartScheduled: () => false
    },
    context: {
      applyPersonaPrompt: (text) => `persona:${text}`,
      buildReplyContext: async () => ({ text: "quoted", imagePaths: ["reply.png"] }),
      ensureTurnContext: (turn) => turn.ctx,
      getChatKey: () => "chat:42",
      telegramMessageMeta: () => ({
        chatType: "private",
        replyToMessageId: 10,
        originMessageId: 11,
        originUpdateId: 12
      })
    },
    codex: {
      formatTurn: (turn) => turn.finalResponse,
      getChatThreadId: () => "saved-thread",
      getOrCreateThread: () => ({ id: "thread-1" }),
      maybeNotifyContextPressure: record("context-pressure"),
      rememberThread: record("remember-thread"),
      runTurn: async (...args) => {
        calls.push(["run-turn", ...args]);
        return { finalResponse: "answer" };
      },
      startThread: () => ({ id: "side-thread" })
    },
    worker: {
      enabled: () => workerEnabled,
      processPreparedTurn: async () => ({
        turn: { finalResponse: "worker answer" },
        threadId: "worker-thread",
        executionMode: "sidecar",
        workerJobId: "job-1"
      })
    },
    recovery: {
      recordActiveTurnCompleted: record("active-completed"),
      recordActiveTurnFailed: record("active-failed"),
      recordActiveTurnStarted: record("active-started"),
      recordTelegramReplyCompleted: record("reply-completed"),
      recordTelegramReplyFailed: record("reply-failed"),
      recordTelegramReplyReady: record("reply-ready"),
      recordTelegramReplyStarted: record("reply-started"),
      restoreThreadForTurn: record("restore-thread")
    },
    progress: {
      createState: (active) => ({ active, messageIds: [] }),
      deleteMessages: record("delete-progress"),
      shouldDelete: (_state, succeeded) => succeeded
    },
    telegram: {
      reactQuietly: record("react"),
      replyCodexAnswer: async (_ctx, text) => {
        calls.push(["answer", text]);
        return { message_id: 99 };
      },
      replyHtml: async (_ctx, html) => {
        replies.push(html);
        return { message_id: replies.length };
      }
    },
    status: {
      buildStatusDetails: async () => ({}),
      formatStatusHtml: () => "status",
      isStatusQuestion: () => false
    },
    sideTurns: {
      track: (...args) => calls.push(["side-track", ...args]),
      untrack: (...args) => calls.push(["side-untrack", ...args])
    },
    text: (key) => key,
    now: () => new Date("2026-07-21T05:06:07.000Z"),
    timers: {
      setInterval: (callback, delay) => {
        calls.push(["timer-start", delay, callback]);
        return 123;
      },
      clearInterval: (id) => calls.push(["timer-clear", id])
    },
    logger: { warn: (...args) => calls.push(["warn", ...args]) }
  });
  return { activeTurns, calls, controller, ctx, pending, replies };
}

test("turn preparation merges reply context, images, routing, and expiry", async () => {
  const { controller, ctx } = createHarness();

  const turn = await controller.prepareCodexTurn(ctx, "current", async () => ["new.png"]);

  assert.equal(turn.id, "turn-1");
  assert.equal(turn.chatKey, "chat:42");
  assert.equal(turn.chatId, 42);
  assert.equal(turn.replyToMessageId, 10);
  assert.deepEqual(turn.imagePaths, ["reply.png", "new.png"]);
  assert.match(turn.inputText, /^persona:Use the following replied-to Telegram message as context\./);
  assert.match(turn.inputText, /<replied_message>\nquoted/);
  assert.match(turn.inputText, /<current_message>\ncurrent/);
  assert.equal(turn.enqueuedAt, "2026-07-21T05:06:07.000Z");
  assert.equal(turn.expiresAt, "2026-07-21T05:07:07.000Z");
});

test("safe mode queues a new message behind an active turn", async () => {
  const { activeTurns, controller, ctx, pending, replies } = createHarness();
  activeTurns.set("chat:42", { abortController: new AbortController() });

  await controller.handleCodexMessage(ctx, "queued", async () => []);

  assert.equal(pending.get("chat:42").length, 1);
  assert.equal(pending.get("chat:42")[0].text, "queued");
  assert.match(replies.at(-1), /Queued Codex turn/);
  assert.match(replies.at(-1), /#1/);
});

test("interrupt mode prepends work and aborts the active turn", async () => {
  const { activeTurns, controller, ctx, pending, replies } = createHarness({
    queueMode: "interrupt"
  });
  const abortController = new AbortController();
  const active = { abortController };
  activeTurns.set("chat:42", active);

  await controller.handleCodexMessage(ctx, "interrupt", async () => []);

  assert.equal(pending.get("chat:42")[0].text, "interrupt");
  assert.equal(active.interruptRequested, true);
  assert.equal(abortController.signal.aborted, true);
  assert.match(replies.at(-1), /interruptRequestedTitle/);
});

test("side mode runs an isolated thread without queueing the message", async () => {
  const { activeTurns, calls, controller, ctx, pending, replies } = createHarness({
    queueMode: "side"
  });
  activeTurns.set("chat:42", { abortController: new AbortController() });

  await controller.handleCodexMessage(ctx, "side question", async () => []);
  await waitForImmediate();

  assert.equal(pending.has("chat:42"), false);
  assert.match(replies[0], /sideTurnStartedTitle/);
  assert.match(replies[1], /Side reply/);
  assert.equal(calls.filter(([name]) => name === "side-track").length, 1);
  assert.equal(calls.filter(([name]) => name === "side-untrack").length, 1);
});

test("prepared inline turns preserve recovery and final-delivery ordering", async () => {
  const { calls, controller, ctx } = createHarness();
  const active = {
    abortController: new AbortController(),
    stopRequested: false
  };
  const preparedTurn = {
    id: "turn-1",
    ctx,
    kind: "user",
    text: "question",
    inputText: "prompt",
    imagePaths: ["image.png"]
  };

  await controller.processPreparedTurn("chat:42", preparedTurn, active);

  assert.equal(active.currentTurnStartedAt, "2026-07-21T05:06:07.000Z");
  assert.equal(active.currentPreparedTurn, preparedTurn);
  const names = calls.map(([name]) => name);
  assert.ok(names.indexOf("restore-thread") < names.indexOf("active-started"));
  assert.ok(names.indexOf("active-started") < names.indexOf("run-turn"));
  assert.ok(names.indexOf("reply-ready") < names.indexOf("reply-started"));
  assert.ok(names.indexOf("reply-started") < names.indexOf("answer"));
  assert.ok(names.indexOf("answer") < names.indexOf("reply-completed"));
  assert.ok(names.indexOf("reply-completed") < names.indexOf("active-completed"));
  assert.equal(calls.find(([name]) => name === "answer")[1], "answer");
  assert.equal(calls.filter(([name]) => name === "delete-progress").length, 1);
  assert.deepEqual(calls.filter(([name]) => name === "react").at(-1).slice(1), [
    ctx,
    "complete",
    true
  ]);
});

test("side prompt explicitly prevents writes while the main turn continues", () => {
  const { controller } = createHarness();
  const prompt = controller.applySideThreadPrompt("status?");
  assert.match(prompt, /side reply/);
  assert.match(prompt, /Avoid file changes or write commands/);
  assert.match(prompt, /status\?$/);
});
