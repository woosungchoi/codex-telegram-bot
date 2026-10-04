import test from "node:test";
import assert from "node:assert/strict";
import { createExecutionComposition } from "../src/runtime/execution_composition.js";
import { accountFixture } from "./helpers/accounts_fixture.mjs";

async function fixture(t, { sidecar, transport, rejectDelivery = false, streamEvents = null }) {
  const { root, config } = await accountFixture(t);
  const state = { chats: { "1": { options: {}, accountId: "default" } }, worker: { deliveries: {} } };
  const answers = [], jobs = [], outcomes = [], progressMessages = [], progressAtDelivery = [];
  const getChatState = () => state.chats["1"];
  const options = { workingDirectory: root, model: "model", streamEvents: Boolean(streamEvents),
    liveProgressEnabled: Boolean(streamEvents), liveProgressSource: "both" };
  const thread = { id: "thread-test", accountId: "default", transport,
    run: async () => ({ finalResponse: "answer" }),
    runStreamed: async () => ({ events: streamEvents }) };
  const worker = { startJob: async (job) => { jobs.push(job); return { jobId: job.id }; },
    readJobEvents: async () => ({ events: streamEvents ? [
      ...streamEvents.map((event, index) => ({ ...event, seq: index + 1 })),
      { seq: streamEvents.length + 1, type: "worker.job.completed" }
    ] : [
      { seq: 1, type: "thread.started", thread_id: thread.id },
      { seq: 2, type: "item.completed", item: { id: "answer", type: "agent_message", text: "answer" } },
      { seq: 3, type: "worker.job.completed" }
    ] }), cancelJob: async () => {} };
  const noop = async () => {};
  const runtime = {
    config: { ...config, codexWorkdir: root, botRecoveryDir: `${root}/recovery`, botRestartRecoveryEnabled: false,
      codexContextGuardEnabled: false }, state, activeTurns: new Map(), pendingTurns: new Map(), threadCache: new Map(),
    getChatState, getEffectiveOptions: () => options, defaultChatOptions: options,
    runtimeValue: (key) => ({ telegramLiveProgressMode: "brief", maxTelegramChars: 4096 }[key] ?? false),
    saveState: noop, getPendingTurns: () => [], persistPendingTurns: noop,
    getChatKey: () => "1", getOrCreateThread: () => thread, startCodexThread: () => thread,
    buildTurnOptions: () => ({}), codexTransport: () => transport, threadTransport: () => transport,
    useWorkerSidecar: () => sidecar, codexWorkerMode: () => sidecar ? "sidecar" : "inline", getWorkerClient: () => worker,
    rememberThread: async (_key, id) => { getChatState().threadId = id; },
    ensureTurnContext: (turn) => turn.ctx, beforeTurn: noop,
    beforeDelivery: async () => { if (rejectDelivery) { const error = new Error("Destination changed"); error.suppressTelegramReply = true; throw error; } },
    onTurnFinished: async (...args) => outcomes.push(args.at(-1)), isQueuePaused: () => false, dequeuePendingTurn: async () => null,
    replyCodexAnswer: async (_ctx, answer) => {
      progressAtDelivery.push([...progressMessages]);
      answers.push(answer);
      return { message_id: 99 };
    },
    replyTrackedProgressHtml: async (_ctx, _state, html) => { progressMessages.push(html); },
    replyHtml: async (_ctx, html) => { throw new Error(`Unexpected error reply: ${html}`); },
    reactQuietly: noop, deleteTrackedProgressMessages: noop, retryPendingProgressCleanup: noop,
    uiLanguage: () => "en", text: (key) => key, textForLanguage: (_lang, key) => key,
    formatTextForLanguage: (_lang, key) => key, redactText: String, truncate: String,
    createQueueItemId: () => "job-test", sleep: noop, readLatestTokenCount: async () => null,
    progressMessageStore: { getRefs: () => [] },
  };
  return { controller: createExecutionComposition(runtime), runtime, answers, jobs, outcomes, progressMessages, progressAtDelivery };
}

for (const sidecar of [false, true]) {
  test(`app-server progress reaches Telegram before final delivery through ${sidecar ? "worker" : "inline"}`, async (t) => {
    const streamEvents = [
      { method: "turn/started", params: { turn: { id: "turn" } } },
      { method: "item/agentMessage/delta", params: { itemId: "message", delta: "Checking " } },
      { method: "item/agentMessage/delta", params: { itemId: "message", delta: "the queue" } },
      { method: "item/completed", params: { item: { id: "message", type: "agentMessage", text: "Checking the queue" } } },
      { method: "item/started", params: { item: { id: "cmd", type: "commandExecution", command: "npm test", status: "inProgress" } } },
      { method: "item/completed", params: { item: { id: "answer", type: "agentMessage", text: "answer" } } },
      { method: "turn/completed", params: { turn: { id: "turn", status: "completed" } } }
    ];
    const original = JSON.parse(JSON.stringify(streamEvents));
    const f = await fixture(t, { sidecar, transport: "app-server-direct", streamEvents });
    await f.controller.runPreparedTurnQueue("1", {
      id: "job-test", ctx: { chat: { id: 1 }, sendChatAction: async () => {} },
      inputText: "hello", imagePaths: []
    }, { abortController: new AbortController() });
    assert.equal(f.progressMessages[0], "liveTurnStarted");
    assert.match(f.progressMessages.join("\n"), /Checking the queue/);
    assert.doesNotMatch(f.progressMessages.join("\n"), /Checking Checking/);
    assert.ok(f.progressMessages.includes("liveCommandRunning"));
    assert.equal(f.progressMessages.at(-1), "liveTurnCompleted");
    assert.deepEqual(f.progressAtDelivery, [f.progressMessages]);
    assert.deepEqual(f.answers, ["answer"]);
    assert.deepEqual(streamEvents, original);
    if (sidecar) assert.equal(Object.values(f.runtime.state.worker.deliveries)[0].seq, streamEvents.length + 1);
  });
}

for (const transport of ["sdk", "app-server-direct"]) {
  for (const sidecar of [false, true]) {
    test(`execution composition delivers once through ${transport}/${sidecar ? "worker" : "inline"}`, async (t) => {
      const f = await fixture(t, { sidecar, transport });
      const ctx = { chat: { id: 1, type: "private" }, sendChatAction: async () => {} };
      const turn = { id: "job-test", ctx, chatId: 1, accountId: "default", text: "hello", inputText: "hello", imagePaths: [] };
      const active = { abortController: new AbortController() };
      f.runtime.activeTurns.set("1", active);
      await f.controller.runPreparedTurnQueue("1", turn, active);
      assert.deepEqual(f.answers, ["answer"]);
      assert.equal(f.outcomes[0].delivered, true);
      assert.equal(f.runtime.activeTurns.size, 0);
      assert.equal(f.jobs.length, sidecar ? 1 : 0);
      if (sidecar) {
        assert.equal(f.jobs[0].transport, transport);
        assert.equal(Object.values(f.runtime.state.worker.deliveries)[0].deliveryStatus, "delivery_sent");
      }
    });
  }
}

test("execution composition applies destination checks before final delivery", async (t) => {
  const f = await fixture(t, { sidecar: true, transport: "sdk", rejectDelivery: true });
  await f.controller.runPreparedTurnQueue("1", { id: "job-test", ctx: { sendChatAction: async () => {} }, inputText: "hello" }, { abortController: new AbortController() });
  assert.deepEqual(f.answers, []);
  assert.equal(f.outcomes[0].delivered, false);
  assert.notEqual(Object.values(f.runtime.state.worker.deliveries)[0].deliveryStatus, "delivery_sent");
});
