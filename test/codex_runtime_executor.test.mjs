import test from "node:test";
import assert from "node:assert/strict";
import { createCodexRuntimeExecutor } from "../src/codex/runtime_executor.js";

function createFixture({ streamEvents = true } = {}) {
  const chat = {};
  const recorded = [];
  let clock = 1000;
  const executor = createCodexRuntimeExecutor({
    settings: {
      recoveryEnabled: false,
      runtimeValue(key) {
        if (key === "codexStreamIdleNoticeMs") return 60_000;
        if (key === "codexStreamIdleAbortMs") return 120_000;
        if (key === "progressEditIntervalMs") return 1000;
        return 0;
      },
      codexPath: "codex",
      codexEnv: {},
      sessionsDir: "/tmp/unused",
      contextGuardEnabled: false,
      contextCompactThresholdPercent: 0,
      contextMinRemainingTokens: 0,
      config: {}
    },
    chats: { get: () => chat, save: async () => { recorded.push("save"); } },
    options: {
      build: (_chatKey, signal) => ({ signal }),
      get: () => ({ streamEvents })
    },
    threads: {
      start: () => null,
      transport: () => "sdk",
      currentTransport: () => "sdk"
    },
    recovery: {
      appendEvent: async (event) => { recorded.push(event.type); },
      recordActiveTurnFailed: async () => {},
      recordBackfill: async () => {},
      recordFinalResponse: async () => { recorded.push("final"); },
      recordFirstItem: async () => { recorded.push("first"); },
      recordIdleNotice: async () => {},
      recordIdleTimeout: async () => {},
      recordIteratorClosed: async () => { recorded.push("closed"); },
      recordStreamItem: async () => { recorded.push("item"); },
      recordStreamStarted: async () => { recorded.push("started"); },
      recordThreadStarted: async () => { recorded.push("thread"); },
      recordUnknownEvent: async () => {}
    },
    progress: {
      editMessage: async () => {},
      maybeSend: async () => {},
      summarize: () => "progress"
    },
    usage: { readLatestTokenCount: async () => null },
    telegram: { replyHtml: async () => {} },
    formatting: { keyValue: () => "", truncate: (value) => value },
    text: (key) => key,
    sleep: async () => {},
    now: () => { clock += 10; return clock; }
  });
  return { executor, chat, recorded };
}

test("non-stream Codex turns delegate once with a linked abort signal", async () => {
  const { executor } = createFixture({ streamEvents: false });
  let received;
  const thread = {
    run: async (input, options) => {
      received = { input, options };
      return { finalResponse: "done" };
    }
  };
  const result = await executor.runCodexTurn({}, "chat", thread, "hello", null);
  assert.equal(result.finalResponse, "done");
  assert.equal(received.input, "hello");
  assert.equal(typeof received.options.signal.aborted, "boolean");
});

test("streamed Codex turns persist thread id and preserve journal ordering", async () => {
  const { executor, chat, recorded } = createFixture();
  async function* events() {
    yield { type: "thread.started", thread_id: "thread-1" };
    yield { type: "item.completed", item: { id: "a", type: "agent_message", text: "done" } };
    yield { type: "turn.completed" };
  }
  const thread = { runStreamed: async () => ({ events: events() }) };

  const result = await executor.runCodexTurn({}, "chat", thread, "hello", null);
  assert.equal(result.finalResponse, "done");
  assert.equal(chat.threadId, "thread-1");
  assert.deepEqual(recorded, [
    "started",
    "save",
    "thread",
    "item",
    "first",
    "final",
    "turn_completed",
    "closed"
  ]);
});
