import test from "node:test";
import assert from "node:assert/strict";
import { createWorkerRuntimeController } from "../src/worker/runtime_controller.js";

function createHarness({
  events = [],
  eventsByJob = null,
  startJobIds = ["job-1"],
  recoveryEnabled = false,
  workerRestartRecoveryAttempts = 3,
  terminalJob = null,
  contextError = null,
  eventErrors = []
} = {}) {
  const chat = { threadId: "thread-existing", outputSchema: { type: "object" } };
  const deliveries = {};
  const calls = [];
  let eventReadCount = 0;
  let startCount = 0;
  const client = {
    async startJob(job) {
      calls.push(["start", job]);
      const jobId = startJobIds[startCount] || `job-${startCount + 1}`;
      startCount += 1;
      return { jobId };
    },
    async readJobEvents(jobId, afterSeq) {
      calls.push(["events", jobId, afterSeq]);
      const error = eventErrors[eventReadCount];
      eventReadCount += 1;
      if (error) throw error;
      const jobEvents = eventsByJob?.[jobId] || events;
      return { events: jobEvents.filter((event) => event.seq > afterSeq) };
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
      recoveryEnabled,
      recoveryDir: "/unused",
      workerRestartRecoveryAttempts,
      workingDirectory: "/workspace",
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
      maybeNotifyContextPressure: contextError
        ? async (...args) => {
          calls.push(["context", ...args]);
          throw contextError;
        }
        : record("context"),
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
      write: recoveryEnabled ? async () => {} : async (write) => write()
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

test("worker event polling retries transient transport failures", async () => {
  const { calls, controller } = createHarness({
    events: completedEvents(),
    eventErrors: [new Error("worker request timed out: job/events")]
  });

  const result = await controller.waitForWorkerJob(
    {},
    "chat:44",
    "job-1",
    { abortController: new AbortController() },
    null
  );

  assert.equal(result.turn.finalResponse, "final answer");
  assert.equal(calls.filter(([name]) => name === "events").length, 2);
  assert.equal(calls.filter(([name]) => name === "sleep").length, 1);
  assert.match(calls.find(([name]) => name === "warn")[1], /worker event polling retry/i);
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

test("sidecar turn starts the worker job when context pressure lookup fails", async () => {
  const { calls, controller } = createHarness({
    events: completedEvents(),
    contextError: new RangeError("Invalid string length")
  });

  const result = await controller.processPreparedTurnViaWorker(
    {},
    "chat:44",
    { id: "turn-1", text: "continue", kind: "user" },
    { abortController: new AbortController() },
    null
  );

  assert.equal(result.workerJobId, "job-1");
  assert.equal(calls.filter(([name]) => name === "start").length, 1);
  assert.ok(calls.findIndex(([name]) => name === "context") < calls.findIndex(([name]) => name === "start"));
  assert.match(calls.find(([name]) => name === "warn")[1], /context pressure check failed/i);
});

test("sidecar turn continues in the same thread after the worker restarts", async () => {
  const { calls, controller } = createHarness({
    eventsByJob: {
      "job-1": [{
        seq: 1,
        type: "worker.job.failed",
        status: "failed",
        message: "worker restarted before job completed"
      }],
      "job-2": completedEvents()
    },
    startJobIds: ["job-1", "job-2"],
    recoveryEnabled: true
  });

  const result = await controller.processPreparedTurnViaWorker(
    {},
    "chat:44",
    { id: "turn-1", text: "finish the interrupted change", kind: "user" },
    { abortController: new AbortController() },
    null
  );

  const starts = calls.filter(([name]) => name === "start");
  assert.equal(result.workerJobId, "job-2");
  assert.equal(result.turn.finalResponse, "final answer");
  assert.equal(starts.length, 2);
  assert.equal(starts[1][1].kind, "recovery");
  assert.equal(starts[1][1].threadId, "thread-existing");
  assert.deepEqual(starts[1][1].imagePaths, []);
  assert.match(starts[1][1].inputText, /codex-telegram-worker restarted/i);
  assert.match(starts[1][1].inputText, /finish the interrupted change/);
  assert.equal(
    calls.filter(([name]) => name === "stream-closed").map((call) => call[2].outcome).join(","),
    "error,completed"
  );
  assert.equal(calls.filter(([name]) => name === "active-failed").length, 0);
  assert.equal(
    calls.some(([name, event]) => name === "recovery" && event.type === "worker_restart_recovery_started"),
    true
  );
});

test("worker restart continuation stops at the configured attempt limit", async () => {
  const restarted = [{
    seq: 1,
    type: "worker.job.failed",
    status: "failed",
    reason: "worker_restart",
    message: "worker process exited"
  }];
  const { calls, controller } = createHarness({
    eventsByJob: { "job-1": restarted, "job-2": restarted },
    startJobIds: ["job-1", "job-2", "job-3"],
    recoveryEnabled: true,
    workerRestartRecoveryAttempts: 1
  });

  await assert.rejects(
    () => controller.processPreparedTurnViaWorker(
      {},
      "chat:44",
      { id: "turn-1", text: "continue", kind: "user" },
      { abortController: new AbortController() },
      null
    ),
    /worker process exited/
  );
  assert.equal(calls.filter(([name]) => name === "start").length, 2);
  assert.equal(
    calls.filter(([name, event]) => name === "recovery" && event.type === "worker_restart_recovery_started").length,
    1
  );
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
