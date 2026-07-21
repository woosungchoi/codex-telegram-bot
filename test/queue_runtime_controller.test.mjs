import test from "node:test";
import assert from "node:assert/strict";
import { createQueueRuntimeController } from "../src/queue/runtime_controller.js";

function createFixture(overrides = {}) {
  const state = overrides.state ?? { queues: {}, worker: { deliveries: {} } };
  const chats = new Map();
  const pendingTurns = new Map();
  const sideTurns = new Map();
  const activeTurns = new Map();
  let saves = 0;
  const controller = createQueueRuntimeController({
    state,
    activeTurns,
    pendingTurns,
    sideTurns,
    settings: {
      maxPendingTurns: () => 3,
      maxPendingAgeSeconds: () => 3600
    },
    chats: {
      get(chatKey) {
        if (!chats.has(chatKey)) chats.set(chatKey, {});
        return chats.get(chatKey);
      }
    },
    persistence: { save: async () => { saves += 1; } },
    telegram: {
      notifyExpired: async () => {},
      createSyntheticContext: (chatKey) => ({ chatKey }),
      replyHtml: async () => {}
    },
    turns: { runPreparedQueue: async () => {} },
    now: () => new Date("2026-07-21T00:00:00.000Z"),
    random: () => 0.5,
    timers: { setTimeout: (callback) => callback() },
    ...overrides
  });
  return { controller, state, chats, pendingTurns, sideTurns, activeTurns, saves: () => saves };
}

test("queue runtime persists enqueue, reorder, dequeue, and clear transitions", async () => {
  const fixture = createFixture();
  const first = { id: "one", text: "one", enqueuedAt: "2026-07-21T00:00:00.000Z" };
  const second = { id: "two", text: "two", enqueuedAt: "2026-07-21T00:00:01.000Z" };

  assert.deepEqual(await fixture.controller.enqueuePendingTurn("chat", first), { ok: true, position: 1 });
  assert.deepEqual(await fixture.controller.enqueuePendingTurn("chat", second), { ok: true, position: 2 });
  assert.equal(await fixture.controller.movePendingTurn("chat", "two", "up"), 1);
  assert.equal((await fixture.controller.dequeuePendingTurn("chat")).id, "two");
  assert.equal(await fixture.controller.clearPendingTurns("chat"), 1);
  assert.deepEqual(fixture.state.queues, {});
  assert.equal(fixture.saves(), 5);
});

test("queue runtime hydrates persisted turns from its injected state", () => {
  const state = {
    queues: {
      chat: [{
        id: "persisted",
        inputText: "resume this turn"
      }]
    },
    worker: { deliveries: {} }
  };
  const fixture = createFixture({ state });

  fixture.controller.hydratePendingTurnsFromState();

  assert.equal(fixture.pendingTurns.get("chat")?.[0]?.id, "persisted");
  assert.equal(fixture.state.queues.chat[0].inputText, "resume this turn");
});

test("queue mode and pause state use safe defaults and persist updates", async () => {
  const fixture = createFixture();
  assert.equal(fixture.controller.getQueueMode("chat"), "safe");
  assert.equal(fixture.controller.isQueuePaused("chat"), false);

  await fixture.controller.setQueueMode("chat", "side");
  await fixture.controller.setQueuePaused("chat", true);
  assert.equal(fixture.controller.getQueueMode("chat"), "side");
  assert.equal(fixture.controller.isQueuePaused("chat"), true);
  assert.equal(fixture.saves(), 2);
});

test("side turns are tracked, counted, aborted, and removed", () => {
  const fixture = createFixture();
  let aborted = 0;
  const first = { abort: () => { aborted += 1; } };
  const second = { abort: () => { aborted += 1; } };
  fixture.controller.trackSideTurn("chat", first);
  fixture.controller.trackSideTurn("chat", second);

  assert.equal(fixture.controller.getSideTurnCount("chat"), 2);
  assert.equal(fixture.controller.countSideTurns(), 2);
  assert.equal(fixture.controller.stopSideTurns("chat"), 2);
  assert.equal(aborted, 2);
  fixture.controller.untrackSideTurn("chat", first);
  fixture.controller.untrackSideTurn("chat", second);
  assert.equal(fixture.controller.getSideTurnCount("chat"), 0);
});
