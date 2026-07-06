import test from "node:test";
import assert from "node:assert/strict";
import {
  applyCodexStreamEvent,
  codexStreamItems,
  codexStreamResult,
  createCodexStreamState
} from "../src/codex/stream.js";

test("codex stream reducer records thread start", () => {
  const state = createCodexStreamState();
  assert.deepEqual(applyCodexStreamEvent(state, { type: "thread.started", thread_id: "thread-1" }), {
    type: "thread_started",
    threadId: "thread-1"
  });
});

test("codex stream reducer tracks items and final agent response", () => {
  const state = createCodexStreamState();
  applyCodexStreamEvent(state, {
    type: "item.started",
    item: { id: "item-1", type: "reasoning", text: "thinking" }
  });
  applyCodexStreamEvent(state, {
    type: "item.completed",
    item: { id: "item-2", type: "agent_message", text: "done" }
  });
  assert.deepEqual(codexStreamItems(state).map((item) => item.id), ["item-1", "item-2"]);
  assert.equal(codexStreamResult(state).finalResponse, "done");
});

test("codex stream reducer records usage and surfaces failures", () => {
  const state = createCodexStreamState();
  assert.deepEqual(applyCodexStreamEvent(state, { type: "turn.completed", usage: { input_tokens: 1 } }), {
    type: "turn_completed",
    usage: { input_tokens: 1 }
  });
  assert.deepEqual(codexStreamResult(state).usage, { input_tokens: 1 });
  assert.deepEqual(applyCodexStreamEvent(state, { type: "turn.failed", error: { message: "bad turn" } }), {
    type: "error",
    message: "bad turn"
  });
});

test("codex stream reducer normalizes response_item message events", () => {
  const state = createCodexStreamState();
  const update = applyCodexStreamEvent(state, {
    type: "response_item",
    payload: {
      id: "msg-1",
      type: "message",
      content: [{ type: "output_text", text: "hello" }, { type: "output_text", text: " world" }]
    }
  });

  assert.equal(update.type, "item");
  assert.equal(update.item.type, "agent_message");
  assert.equal(update.finalResponseChanged, true);
  assert.equal(codexStreamResult(state).finalResponse, "hello world");
});

test("codex stream reducer normalizes event_msg agent and task events", () => {
  const state = createCodexStreamState();
  assert.equal(applyCodexStreamEvent(state, {
    type: "event_msg",
    payload: { type: "agent_message", message: "done" }
  }).type, "item");
  assert.equal(codexStreamResult(state).finalResponse, "done");
  assert.deepEqual(applyCodexStreamEvent(state, {
    type: "event_msg",
    payload: { type: "task_complete" }
  }), { type: "turn_completed", usage: null });
  assert.deepEqual(applyCodexStreamEvent(state, {
    type: "event_msg",
    payload: { type: "task_failed", message: "failed" }
  }), { type: "error", message: "failed" });
});

test("codex stream reducer ignores unknown events without throwing", () => {
  const state = createCodexStreamState();
  assert.deepEqual(applyCodexStreamEvent(state, {
    type: "event_msg",
    payload: { type: "new_future_event" }
  }), {
    type: "unknown",
    eventType: "event_msg"
  });
});
