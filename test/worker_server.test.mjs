import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createWorkerClient } from "../src/worker/client.js";
import { createWorkerServer } from "../src/worker/server.js";
import { createWorkerStore } from "../src/worker/store.js";

async function startServer(executeJob, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-worker-server-"));
  const config = {
    codexWorkerStateDir: dir,
    codexWorkerSocket: path.join(dir, "worker.sock"),
    codexWorkerConnectTimeoutMs: 1000,
    codexTransport: "sdk"
  };
  const store = createWorkerStore(config);
  const worker = createWorkerServer({ config, store, executeJob, logger: { warn() {} }, ...options });
  await worker.listen();
  return { config, worker, client: createWorkerClient(config), store };
}

test("worker server reports status", async () => {
  const { worker, client } = await startServer(async () => {});
  try {
    assert.deepEqual(await client.status(), { status: "ok", activeJobs: [], runningJobIds: [] });
  } finally {
    await worker.close();
  }
});

test("worker server writes heartbeat events for running jobs", async () => {
  const executeJob = async ({ signal }) => {
    if (!signal.aborted) {
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    }
  };
  const { worker, client } = await startServer(executeJob, { heartbeatMs: 5 });
  try {
    await client.startJob({ id: "job-heartbeat", chatKey: "chat-heartbeat", inputText: "hi" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const events = await client.readJobEvents("job-heartbeat", 0);
    assert.equal(events.events.some((event) => event.type === "worker.heartbeat"), true);
    await client.cancelJob("job-heartbeat");
  } finally {
    await worker.close();
  }
});

test("worker server records shutdown for active jobs", async () => {
  const executeJob = async ({ signal }) => {
    if (!signal.aborted) {
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    }
  };
  const { worker, client, store } = await startServer(executeJob);
  await client.startJob({ id: "job-shutdown", chatKey: "chat-shutdown", inputText: "hi" });
  await worker.close();
  const events = await store.readJobEvents("job-shutdown", { afterSeq: 0 });
  assert.equal(events.some((event) => event.type === "worker.shutdown"), true);
});

test("worker server starts, rejects duplicate chat jobs, and cancels", async () => {
  const executeJob = async ({ job, store, signal }) => {
    await store.appendJobEvent(job.id, { type: "worker.job.started", status: "running", chatKey: job.chatKey });
    if (!signal.aborted) {
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    }
    await store.appendJobEvent(job.id, { type: "worker.job.cancelled", status: "cancelled", chatKey: job.chatKey });
  };
  const { worker, client } = await startServer(executeJob);
  try {
    assert.deepEqual(await client.startJob({ id: "job-1", chatKey: "chat-1", inputText: "hi" }), {
      jobId: "job-1",
      status: "accepted"
    });
    await assert.rejects(
      () => client.startJob({ id: "job-2", chatKey: "chat-1", inputText: "hi again" }),
      /Active worker job already exists/
    );
    assert.equal((await client.status()).activeJobs.length, 1);
    assert.deepEqual(await client.cancelJob("job-1"), { jobId: "job-1", cancelled: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const events = await client.readJobEvents("job-1", 0);
    assert.equal(events.events.some((event) => event.type === "worker.job.cancelled"), true);
  } finally {
    await worker.close();
  }
});
