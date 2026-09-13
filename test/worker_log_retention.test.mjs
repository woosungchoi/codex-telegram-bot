import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createWorkerClient } from "../src/worker/client.js";
import { createWorkerServer } from "../src/worker/server.js";
import { createWorkerStore } from "../src/worker/store.js";
import { createWorkerLogMaintenance } from "../src/worker/log_retention.js";

const old = "2025-01-01T00:00:00.000Z";
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "worker-retention-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = {
    codexWorkerStateDir: path.join(root, "worker"),
    stateFile: path.join(root, "state.json"),
    botRecoveryDir: path.join(root, "recovery"),
  };
  await fs.mkdir(config.botRecoveryDir);
  const store = createWorkerStore(config);
  await store.ensure();
  const state = { worker: { deliveries: {} }, queues: {} };
  const save = () => fs.writeFile(config.stateFile, JSON.stringify(state));
  await save();
  const maintenance = createWorkerLogMaintenance({
    config,
    store,
    now: () => Date.parse("2026-09-13"),
  });
  const job = async (id, delivered = true) => {
    await store.writeJobState({
      id,
      chatKey: "chat",
      acceptedAt: old,
      completedAt: old,
      status: "completed",
    });
    await store.appendJobEvent(id, {
      type: "item.completed",
      item: { type: "agent_message", text: "보존🙂".repeat(1000) },
      at: old,
    });
    await store.appendJobEvent(id, {
      type: "worker.job.completed",
      status: "completed",
      at: old,
    });
    if (delivered)
      state.worker.deliveries[`chat:${id}`] = {
        jobId: id,
        chatKey: "chat",
        deliveryStatus: "delivery_sent",
        ambiguous: false,
        seq: 2,
        sentAt: old,
      };
    await save();
  };
  return { config, store, state, save, maintenance, job };
}

test("preview changes nothing; confirmed archives preserve replay and integrity", async (t) => {
  const f = await fixture(t);
  await f.job("done");
  const before = await f.store.readJobEvents("done");
  const eventFile = path.join(f.store.paths.eventsDir, "done.jsonl");
  const preview = await f.maintenance.run();
  assert.equal(preview.eligible, 1);
  assert.equal(preview.archived, 0);
  assert.equal((await f.store.readJobState("done")).deliveryReceipt, undefined);
  const result = await f.maintenance.run({ apply: true });
  assert.equal(result.archived, 1);
  assert.ok(result.compressedBytes < result.originalBytes);
  await assert.rejects(fs.stat(eventFile), { code: "ENOENT" });
  assert.deepEqual(await f.store.readJobEvents("done"), before);
  assert.deepEqual(
    await f.store.readJobEvents("done", { afterSeq: 1, limit: 1 }),
    before.slice(1),
  );
  const job = await f.store.readJobState("done"),
    file = path.join(f.store.paths.archivesDir, job.eventArchive.file);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  const bytes = await fs.readFile(file);
  bytes[Math.floor(bytes.length / 2)] ^= 1;
  await fs.writeFile(file, bytes);
  await assert.rejects(f.store.readJobEvents("done"));
});

test("age never overrides missing confirmation, active, queued, snapshot or ambiguous protection", async (t) => {
  const f = await fixture(t);
  for (const id of [
    "unknown",
    "active",
    "queued",
    "snapshot",
    "uncertain",
    "failed",
    "safe",
  ])
    await f.job(id, id !== "unknown");
  await f.store.upsertActiveJob({ id: "active" });
  f.state.queues.chat = [{ recovery: { workerJobId: "queued" } }];
  await fs.writeFile(
    path.join(f.config.botRecoveryDir, "active-turns.json"),
    JSON.stringify({ turns: { chat: { workerJobId: "snapshot" } } }),
  );
  f.state.worker.deliveries["chat:uncertain"].ambiguous = true;
  await f.store.writeJobState({ id: "failed", status: "failed" });
  await f.save();
  const result = await f.maintenance.run({ apply: true });
  assert.equal(result.archived, 1);
  assert.equal(result.protected, 6);
  assert.equal((await fs.readdir(f.store.paths.eventsDir)).length, 6);
});

test("receipts survive bot ledger pruning but never authorize a reused job identity", async (t) => {
  const f = await fixture(t);
  await f.job("done");
  assert.equal(
    (await f.store.confirmDelivery(f.state.worker.deliveries["chat:done"]))
      .recorded,
    true,
  );
  f.state.worker.deliveries = {};
  await f.save();
  assert.equal((await f.maintenance.run()).eligible, 1);
  await f.store.writeJobState({
    id: "done",
    acceptedAt: "2025-02-01T00:00:00Z",
  });
  assert.equal((await f.maintenance.run({ apply: true })).archived, 0);
});

test("malformed protection files fail closed without removing logs", async (t) => {
  const f = await fixture(t);
  await f.job("done");
  await fs.writeFile(f.config.stateFile, "{broken");
  await assert.rejects(f.maintenance.run({ apply: true }), SyntaxError);
  assert.equal((await fs.readdir(f.store.paths.eventsDir)).length, 1);
});

test("archived jobs cannot append or reuse their identity, and malformed snapshots block archival", async (t) => {
  const f = await fixture(t);
  await f.job("done");
  await f.maintenance.run({ apply: true });
  await assert.rejects(
    f.store.appendJobEvent("done", { type: "worker.heartbeat" }),
    /immutable/,
  );
  await assert.rejects(
    f.store.writeJobState({ id: "done", acceptedAt: new Date().toISOString() }),
    /immutable/,
  );
  assert.equal((await f.store.readJobEvents("done")).length, 2);
  await f.job("next");
  await fs.writeFile(
    path.join(f.config.botRecoveryDir, "active-turns.json"),
    JSON.stringify({ turns: [] }),
  );
  await assert.rejects(f.maintenance.run({ apply: true }), /Malformed/);
  assert.equal((await fs.readdir(f.store.paths.eventsDir)).length, 1);
});

test("worker RPC records delivery proof and exposes preview/apply with archived event replay", async (t) => {
  const f = await fixture(t);
  await f.job("done");
  f.config.codexWorkerSocket = path.join(f.store.paths.stateDir, "worker.sock");
  const worker = createWorkerServer({
    config: f.config,
    store: f.store,
    logger: { warn() {} },
  });
  await worker.listen();
  try {
    const client = createWorkerClient(f.config);
    assert.equal(
      (await client.confirmDelivery(f.state.worker.deliveries["chat:done"]))
        .recorded,
      true,
    );
    assert.equal((await client.archiveLogs()).archived, 0);
    assert.equal((await client.archiveLogs({ apply: true })).archived, 1);
    assert.equal(
      (await client.readJobEvents("done", 1)).events[0].type,
      "worker.job.completed",
    );
    await assert.rejects(
      client.startJob({ id: "done", chatKey: "chat" }),
      /immutable/,
    );
  } finally {
    await worker.close();
  }
});
