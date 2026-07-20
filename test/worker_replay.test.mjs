import test from "node:test";
import assert from "node:assert/strict";
import { reconstructCompletedWorkerJob } from "../src/worker/replay.js";

function createClient(events, job = { id: "job-1", status: "completed", lastSeq: events.length }) {
  const calls = [];
  return {
    calls,
    async readJobEvents(jobId, afterSeq, limit) {
      calls.push({ method: "events", jobId, afterSeq, limit });
      return { events: events.filter((event) => event.seq > afterSeq).slice(0, limit) };
    },
    async getJobStatus(jobId) {
      calls.push({ method: "status", jobId });
      return { job };
    }
  };
}

test("completed worker replay reconstructs final response without starting or mutating a job", async () => {
  const client = createClient([
    { seq: 1, type: "worker.job.accepted", status: "accepted" },
    { seq: 2, type: "thread.started", thread_id: "thread-1" },
    { seq: 3, type: "item.completed", item: { id: "message-1", type: "agent_message", text: "final answer" } },
    { seq: 4, type: "turn.completed", usage: { input_tokens: 1 } },
    { seq: 5, type: "worker.job.completed", status: "completed", threadId: "thread-1" }
  ]);
  const result = await reconstructCompletedWorkerJob(client, "job-1");
  assert.equal(result.turn.finalResponse, "final answer");
  assert.equal(result.threadId, "thread-1");
  assert.equal(result.workerLastSeq, 5);
  assert.deepEqual(client.calls.map((call) => call.method), ["events"]);
});

test("completed worker replay uses terminal job status when the terminal event page is exhausted", async () => {
  const client = createClient([
    { seq: 1, type: "thread.started", thread_id: "thread-1" },
    { seq: 2, type: "item.completed", item: { id: "message-1", type: "agent_message", text: "done" } }
  ], { id: "job-1", status: "completed", lastSeq: 2 });
  const result = await reconstructCompletedWorkerJob(client, "job-1");
  assert.equal(result.turn.finalResponse, "done");
  assert.equal(result.workerLastSeq, 2);
  assert.deepEqual(client.calls.map((call) => call.method), ["events", "events", "status"]);
});

test("completed worker replay refuses a terminal status with missing persisted events", async () => {
  const client = createClient([
    { seq: 1, type: "thread.started", thread_id: "thread-1" },
    { seq: 2, type: "item.completed", item: { id: "message-1", type: "agent_message", text: "partial" } }
  ], { id: "job-1", status: "completed", lastSeq: 3 });
  await assert.rejects(
    () => reconstructCompletedWorkerJob(client, "job-1"),
    /event log is incomplete \(2\/3\)/
  );
});

test("worker replay refuses non-terminal, failed, and cancelled jobs", async () => {
  for (const [status, pattern] of [
    ["running", /not terminal/],
    ["failed", /failed/],
    ["cancelled", /cancelled/]
  ]) {
    const client = createClient([], { id: "job-1", status, lastSeq: 0, error: `${status} detail` });
    await assert.rejects(() => reconstructCompletedWorkerJob(client, "job-1"), pattern);
  }
});

test("worker replay refuses a failed Codex stream even if no worker terminal event was read", async () => {
  const client = createClient([
    { seq: 1, type: "turn.failed", error: { message: "bad turn" } }
  ]);
  await assert.rejects(() => reconstructCompletedWorkerJob(client, "job-1"), /bad turn/);
});
