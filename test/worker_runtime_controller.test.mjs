import test from "node:test";
import assert from "node:assert/strict";
import { createWorkerRuntimeController } from "../src/worker/runtime_controller.js";

function createHarness({ events = [], terminalJob = null } = {}) {
  const chat = { threadId: "thread-existing", outputSchema: { type: "object" } };
  const deliveries = {};
  const calls = [];
  const client = {
    async startJob(job) {
      calls.push(["start", job]);
      return { jobId: "job-1" };
    },
    async readJobEvents(jobId, afterSeq) {
      calls.push(["events", jobId, afterSeq]);
      return { events: events.filter((event) => event.seq > afterSeq) };
    },
    async getJobStatus(jobId) {
      calls.push(["status", jobId]);
      return { job: terminalJob };
    },
    async cancelJob(jobId) {
      calls.push(["cancel", jobId]);
    }
  };
  let clock = 1000;
  const record = (name) => async (...args) => calls.push([name, ...args]);
  const controller = createWorkerRuntimeController({
    settings: {
      recoveryEnabled: false,
      recoveryDir: "/unused",
      eventPollMs: () => 1
    },
    deliveryStore: {
      get: (key) => deliveries[key],
      set: (key, value) => {
        deliveries[key] = value;
      },
      save: record("save")
    },
    chatStore: {
      get: () => chat,
      getEffectiveOptions: () => ({ model: "gpt-test", serviceTier: "fast" })
    },
    worker: {
      getClient: () => client,
      mode: () => "sidecar",
      transport: () => "app-server-direct"
    },
    turn: {
      createQueueItemId: () => "generated-id",
      maybeNotifyContextPressure: record("context"),
      maybeSendLiveProgress: record("progress"),
      recordActiveTurnFailed: record("active-failed"),
      recordCodexStreamFinalResponseSeen: record("final-seen"),
      recordCodexStreamFirstItem: record("first-item"),
      recordCodexStreamIteratorClosed: record("stream-closed"),
      recordCodexStreamStarted: record("stream-started"),
      recordCodexStreamUnknownEvent: record("unknown"),
      recordStreamItemEvent: record("item"),
      recordThreadStarted: record("thread-started")
    },
    recovery: {
      appendEvent: record("recovery"),
      write: async (write) => write()
    },
    sleep: record("sleep"),
    now: () => new Date("2026-07-21T04:05:06.000Z"),
    nowMs: () => {
      clock += 10;
      return clock;
    },
    logger: { warn: (...args) => calls.push(["warn", ...args]) }
  });
  return { calls, chat, client, controller, deliveries };
}

function completedEvents() {
  return [
    { seq: 1, type: "worker.job.accepted", status: "accepted" },
    { seq: 2, type: "thread.started", thread_id: "thread-new" },
    {
      seq: 3,
      type: "item.completed",
      item: { id: "answer", type: "agent_message", text: "final answer" }
    },
    { seq: 4, type: "turn.completed", usage: { input_tokens: 2 } },
    {
      seq: 5,
      type: "worker.job.completed",
      status: "completed",
      threadId: "thread-new"
    }
  ];
}

test("worker payload captures effective chat options and Telegram routing", () => {
  const { controller } = createHarness();

  const payload = controller.createWorkerJobPayload("chat:44", {
    chatId: -1001,
    chatType: "supergroup",
    messageThreadId: 44,
    replyToMessageId: 55,
    text: "hello",
    imagePaths: ["/tmp/image.png"],
    recovery: { threadId: "thread-recovery" }
  });

  assert.deepEqual(payload, {
    id: "generated-id",
    chatKey: "chat:44",
    chatId: -1001,
    chatType: "supergroup",
    messageThreadId: 44,
    replyToMessageId: 55,
    originMessageId: undefined,
    originUpdateId: undefined,
    kind: "user",
    text: "hello",
    inputText: "hello",
    imagePaths: ["/tmp/image.png"],
    threadId: "thread-recovery",
    effectiveOptions: { model: "gpt-test", serviceTier: "fast" },
    outputSchema: { type: "object" },
    transport: "app-server-direct",
    enqueuedAt: "2026-07-21T04:05:06.000Z",
    recovery: { threadId: "thread-recovery" }
  });
});

test("worker event polling persists monotonic cursors and reconstructs the turn", async () => {
  const { calls, chat, controller, deliveries } = createHarness({
    events: completedEvents()
  });
  const active = { abortController: new AbortController() };

  const result = await controller.waitForWorkerJob(
    {},
    "chat:44",
    "job-1",
    active,
    { chatKey: "chat:44" }
  );

  assert.equal(result.threadId, "thread-new");
  assert.equal(result.turn.finalResponse, "final answer");
  assert.equal(result.turn.usage.input_tokens, 2);
  assert.equal(result.workerLastSeq, 5);
  assert.equal(active.workerEventSeq, 5);
  assert.equal(chat.threadId, "thread-new");
  assert.equal(deliveries["chat:44:job-1"].seq, 5);
  assert.equal(calls.filter(([name]) => name === "first-item").length, 1);
  assert.equal(calls.filter(([name]) => name === "final-seen").length, 1);
  assert.equal(calls.filter(([name]) => name === "stream-closed").length, 1);
  assert.equal(calls.find(([name]) => name === "stream-closed")[2].outcome, "completed");
});

test("sidecar turn starts one job and sends at most one cancellation request", async () => {
  const { calls, controller } = createHarness({ events: completedEvents() });
  const abortController = new AbortController();
  abortController.abort();
  const active = { abortController };

  const result = await controller.processPreparedTurnViaWorker(
    {},
    "chat:44",
    { id: "turn-1", text: "hello", kind: "user" },
    active,
    null
  );

  assert.equal(result.executionMode, "sidecar");
  assert.equal(result.workerJobId, "job-1");
  assert.equal(active.workerJobId, "job-1");
  assert.equal(active.workerEventSeq, 5);
  assert.equal(calls.filter(([name]) => name === "start").length, 1);
  assert.equal(calls.filter(([name]) => name === "cancel").length, 1);
});

test("failed worker terminal events close the stream with an error outcome", async () => {
  const { calls, controller } = createHarness({
    events: [{ seq: 1, type: "worker.job.failed", status: "failed", message: "boom" }]
  });

  await assert.rejects(
    () => controller.waitForWorkerJob(
      {},
      "chat:44",
      "job-1",
      { abortController: new AbortController() },
      null
    ),
    /boom/
  );
  assert.equal(calls.find(([name]) => name === "stream-closed")[2].outcome, "error");
});
