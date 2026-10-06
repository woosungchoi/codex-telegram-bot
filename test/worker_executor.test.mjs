import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runWorkerJob } from "../src/worker/executor.js";
import { createWorkerStore } from "../src/worker/store.js";

async function tempStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-worker-executor-"));
  const store = createWorkerStore({ codexWorkerStateDir: dir });
  await store.ensure();
  return store;
}

async function readRawJobState(store, jobId) {
  return JSON.parse(await fs.readFile(path.join(store.paths.jobsDir, `${jobId}.json`), "utf8"));
}

for (const [effort, transport] of [["max", "sdk"], ["ultra", "app-server-direct"]]) {
  test(`worker executor writes stream events and completion with ${effort} reasoning`, async (t) => {
    // Given
    const store = await tempStore();
    t.after(() => fs.rm(store.paths.stateDir, { recursive: true, force: true }));
    const effectiveOptions = {
      model: "gpt-5.6-sol",
      modelReasoningEffort: effort
    };
    let capturedThreadOptions = null;
    const createThread = (options) => {
      capturedThreadOptions = options;
      return {
        id: "thread-1",
        async runStreamed() {
          return {
            events: (async function* events() {
              yield { type: "thread.started", thread_id: "thread-1" };
              yield { type: "item.completed", item: { id: "msg-1", type: "agent_message", text: "done" } };
              yield { type: "turn.completed", usage: { total_tokens: 3 } };
            })()
          };
        }
      };
    };

    // When
    const result = await runWorkerJob({
      job: { id: `job-${effort}`, chatKey: "chat-1", inputText: "hello", transport, effectiveOptions },
      config: { codexTransport: "sdk" },
      store,
      signal: new AbortController().signal,
      createThread
    });

    // Then
    assert.equal(capturedThreadOptions.transport, transport);
    assert.deepEqual(capturedThreadOptions.effectiveOptions, effectiveOptions);
    assert.equal(result.finalResponse, "done");
    assert.deepEqual((await store.readJobEvents(`job-${effort}`, { afterSeq: 0 })).map((event) => event.type), [
      "worker.job.started",
      "thread.started",
      "item.completed",
      "turn.completed",
      "worker.job.completed"
    ]);
    const job = await store.readJobState(`job-${effort}`);
    assert.equal(job.status, "completed");
    assert.ok(Number.isFinite(Date.parse(job.completedAt)));
    assert.equal(job.lastSeq, (await store.readJobEvents(`job-${effort}`)).at(-1).seq);
  });
}

test("immediate delivery confirmation after terminal observation records the final receipt", async (t) => {
  const store = await tempStore();
  t.after(() => fs.rm(store.paths.stateDir, { recursive: true, force: true }));
  const acceptedAt = "2020-01-01T00:00:00.000Z";
  await store.writeJobState({ id: "receipt-race", chatKey: "123:topic:456", acceptedAt, status: "accepted" });

  const appendJobEvent = store.appendJobEvent.bind(store);
  let callbackCount = 0;
  let receiptResult;
  store.appendJobEvent = async (jobId, event) => {
    const appended = await appendJobEvent(jobId, event);
    if (event.type === "worker.job.completed") {
      const observed = await store.readJobState(jobId);
      assert.equal(observed.status, "completed");
      assert.ok(Number.isFinite(Date.parse(observed.completedAt)));
      callbackCount += 1;
      receiptResult = await store.confirmDelivery({
        jobId,
        chatKey: observed.chatKey,
        deliveryStatus: "delivery_sent",
        ambiguous: false,
        seq: observed.lastSeq,
        sentAt: new Date(Date.parse(observed.completedAt) + 1000).toISOString()
      });
    }
    return appended;
  };

  await runWorkerJob({
    job: { id: "receipt-race", chatKey: "123:topic:456", acceptedAt, inputText: "hello" },
    config: {},
    store,
    createThread: () => ({
      id: "thread-final",
      async runStreamed() {
        return { events: (async function* events() {
          yield { type: "item.completed", item: { id: "final", type: "agent_message", text: "done" } };
        })() };
      }
    })
  });

  const job = await store.readJobState("receipt-race");
  assert.equal(callbackCount, 1);
  assert.deepEqual(receiptResult, { recorded: true });
  assert.deepEqual(job.deliveryReceipt, {
    acceptedAt,
    chatKey: "123:topic:456",
    seq: job.lastSeq,
    sentAt: new Date(Date.parse(job.completedAt) + 1000).toISOString()
  });
});

test("raw turn completion cannot expose a terminal job before worker publication", async (t) => {
  const store = await tempStore();
  t.after(() => fs.rm(store.paths.stateDir, { recursive: true, force: true }));
  const id = "raw-turn-completed";
  const acceptedAt = "2020-01-01T00:00:00.000Z";
  await store.writeJobState({ id, chatKey: "chat", acceptedAt, status: "accepted", lastSeq: 0 });
  await runWorkerJob({
    job: { id, chatKey: "chat", acceptedAt, lastSeq: 0 }, config: {}, store,
    createThread: () => ({
      async runStreamed() {
        return { events: (async function* () {
          yield { type: "turn.completed", usage: { total_tokens: 3 } };
          const job = await readRawJobState(store, id);
          assert.equal(job.status, "running");
          assert.equal(job.completedAt, undefined);
          assert.equal(job.terminalEvent, undefined);
          assert.deepEqual(await store.confirmDelivery({
            jobId: id, chatKey: "chat", deliveryStatus: "delivery_sent",
            ambiguous: false, seq: job.lastSeq, sentAt: new Date().toISOString()
          }), { recorded: false });
        })() };
      }
    })
  });
  const job = await readRawJobState(store, id);
  assert.equal(job.status, "completed");
  assert.equal(job.lastSeq, job.terminalEvent.seq);
});

test("worker executor writes failed events", async (t) => {
  const store = await tempStore();
  t.after(() => fs.rm(store.paths.stateDir, { recursive: true, force: true }));
  const createThread = () => ({
    id: "thread-1",
    async runStreamed() {
      throw new Error("boom");
    }
  });
  await assert.rejects(
    () => runWorkerJob({
      job: { id: "job-1", chatKey: "chat-1", inputText: "hello", effectiveOptions: {}, lastSeq: 0 },
      config: { codexTransport: "sdk" },
      store,
      signal: new AbortController().signal,
      createThread
    }),
    /boom/
  );
  const events = await store.readJobEvents("job-1", { afterSeq: 0 });
  assert.equal(events.at(-1).type, "worker.job.failed");
  const job = await store.readJobState("job-1");
  assert.equal(job.status, "failed");
  assert.ok(Number.isFinite(Date.parse(job.completedAt)));
  assert.equal(events.at(-1).completedAt, job.completedAt);
  const rawJob = await readRawJobState(store, "job-1");
  assert.equal(rawJob.status, "failed");
  assert.equal(rawJob.completedAt, events.at(-1).completedAt);
  assert.equal(rawJob.lastSeq, events.at(-1).seq);
});

test("worker cancellation publishes a timestamp with the terminal event", async (t) => {
  const store = await tempStore();
  t.after(() => fs.rm(store.paths.stateDir, { recursive: true, force: true }));
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  await assert.rejects(runWorkerJob({
    job: { id: "cancelled", chatKey: "chat-1", inputText: "hello", lastSeq: 0 },
    config: {},
    store,
    signal: controller.signal,
    createThread: () => ({ async runStreamed() { throw new Error("cancelled"); } })
  }), /cancelled/);
  const job = await store.readJobState("cancelled");
  const event = (await store.readJobEvents("cancelled")).at(-1);
  assert.equal(job.status, "cancelled");
  assert.ok(Number.isFinite(Date.parse(job.completedAt)));
  assert.equal(event.completedAt, job.completedAt);
  const rawJob = await readRawJobState(store, "cancelled");
  assert.equal(rawJob.status, "cancelled");
  assert.equal(rawJob.completedAt, event.completedAt);
  assert.equal(rawJob.lastSeq, event.seq);
});

test("a terminal streamed failure never produces a completed worker job", async (t) => {
  const store = await tempStore();
  t.after(() => fs.rm(store.paths.stateDir, { recursive: true, force: true }));
  const createThread = () => ({
    async runStreamed() {
      return { events: (async function* () {
        yield { type: "turn.failed", error: { message: "usage limit", codexErrorInfo: "usageLimitExceeded" } };
      })() };
    }
  });
  await assert.rejects(runWorkerJob({ job: { id: "failure", chatKey: "chat" }, config: {}, store, createThread }), /usage limit/);
  assert.equal((await store.readJobState("failure")).status, "failed");
  assert.equal((await store.readJobEvents("failure")).some((e) => e.type === "worker.job.completed"), false);
});

test("worker failures retain locale metadata through persisted events and status replay", async (t) => {
  const { LocalizedError, errorText } = await import("../src/i18n.js");
  const { reconstructCompletedWorkerJob } = await import("../src/worker/replay.js");
  const store = await tempStore();
  t.after(() => fs.rm(store.paths.stateDir, { recursive: true, force: true }));
  await assert.rejects(runWorkerJob({
    job: { id: "localized-job", chatKey: "chat", text: "hello" }, config: {}, store,
    createThread: () => { throw new LocalizedError("errors.telegramDownload", { status: 403 }); }
  }), /Telegram file download failed: 403/);
  const events = await store.readJobEvents("localized-job", { afterSeq: 0 });
  const job = await store.readJobState("localized-job");
  for (const replayEvents of [events, []]) {
    const client = { readJobEvents: async () => ({ events: replayEvents }), getJobStatus: async () => ({ job: { ...job, lastSeq: 0 } }) };
    await assert.rejects(reconstructCompletedWorkerJob(client, "localized-job"), (error) => {
      assert.equal(error.message, "Telegram file download failed: 403");
      assert.equal(errorText(error, "ru"), "Не удалось скачать файл Telegram: 403");
      return true;
    });
  }
});
