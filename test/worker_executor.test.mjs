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
    assert.equal((await store.readJobState(`job-${effort}`)).status, "completed");
  });
}

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
      job: { id: "job-1", chatKey: "chat-1", inputText: "hello", effectiveOptions: {} },
      config: { codexTransport: "sdk" },
      store,
      signal: new AbortController().signal,
      createThread
    }),
    /boom/
  );
  const events = await store.readJobEvents("job-1", { afterSeq: 0 });
  assert.equal(events.at(-1).type, "worker.job.failed");
  assert.equal((await store.readJobState("job-1")).status, "failed");
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
