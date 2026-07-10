import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createWorkerClient } from "../src/worker/client.js";
import { createWorkerServer } from "../src/worker/server.js";
import { createWorkerStore } from "../src/worker/store.js";

function mode(stat) {
  return stat.mode & 0o777;
}

async function startServer(executeJob, options = {}) {
  const { prepareStore, ...serverOptions } = options;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-worker-server-"));
  const config = {
    codexWorkerStateDir: dir,
    codexWorkerSocket: path.join(dir, "worker.sock"),
    codexWorkerConnectTimeoutMs: 1000,
    codexTransport: "sdk"
  };
  const store = createWorkerStore(config);
  await prepareStore?.(store);
  const worker = createWorkerServer({ config, store, executeJob, logger: { warn() {} }, ...serverOptions });
  await worker.listen();
  return { config, worker, client: createWorkerClient(config), store };
}

test("worker server reports status", async () => {
  const { config, worker, client } = await startServer(async () => {});
  try {
    assert.deepEqual(await client.status(), { status: "ok", activeJobs: [], runningJobIds: [] });
    assert.equal(mode(await fs.stat(config.codexWorkerSocket)), 0o600);
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

test("worker close waits for active job cleanup", async (t) => {
  let releaseCleanup;
  let markCleanupStarted;
  const cleanupGate = new Promise((resolve) => {
    releaseCleanup = resolve;
  });
  const cleanupStarted = new Promise((resolve) => {
    markCleanupStarted = resolve;
  });
  t.after(() => releaseCleanup());

  const executeJob = async ({ job, store, signal }) => {
    if (!signal.aborted) {
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    }
    markCleanupStarted();
    await cleanupGate;
    await store.appendJobEvent(job.id, {
      type: "worker.job.cancelled",
      status: "cancelled",
      chatKey: job.chatKey
    });
  };
  const { worker, client, store } = await startServer(executeJob);
  await client.startJob({ id: "job-close", chatKey: "chat-close", inputText: "hi" });

  const closing = worker.close();
  await cleanupStarted;
  const closeState = await Promise.race([
    closing.then(() => "closed"),
    new Promise((resolve) => setTimeout(() => resolve("waiting"), 50))
  ]);
  assert.equal(closeState, "waiting");

  releaseCleanup();
  await closing;
  assert.equal((await store.readActiveJobs()).jobs["job-close"], undefined);
  assert.equal((await store.readJobState("job-close")).status, "cancelled");
});

test("worker startup marks persisted orphaned jobs failed", async () => {
  const { worker, client, store } = await startServer(async () => {}, {
    prepareStore: async (preparedStore) => {
      await preparedStore.writeJobState({ id: "job-orphan", chatKey: "chat-orphan", status: "running" });
      await preparedStore.upsertActiveJob({ id: "job-orphan", chatKey: "chat-orphan", status: "running" });
    }
  });
  try {
    assert.deepEqual(await client.status(), { status: "ok", activeJobs: [], runningJobIds: [] });
    assert.equal((await store.readJobState("job-orphan")).status, "failed");
    const events = await store.readJobEvents("job-orphan", { afterSeq: 0 });
    assert.equal(events.at(-1).type, "worker.job.failed");
  } finally {
    await worker.close();
  }
});

test("worker cancel finalizes a persisted orphan without a controller", async () => {
  const { worker, client, store } = await startServer(async () => {});
  try {
    await store.writeJobState({ id: "job-orphan", chatKey: "chat-orphan", status: "running" });
    await store.upsertActiveJob({ id: "job-orphan", chatKey: "chat-orphan", status: "running" });

    assert.deepEqual(await client.cancelJob("job-orphan"), {
      jobId: "job-orphan",
      cancelled: true,
      orphaned: true
    });
    assert.deepEqual((await client.status()).activeJobs, []);
    assert.equal((await store.readJobState("job-orphan")).status, "cancelled");
    const events = await store.readJobEvents("job-orphan", { afterSeq: 0 });
    assert.equal(events.at(-1).type, "worker.job.cancelled");
  } finally {
    await worker.close();
  }
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
