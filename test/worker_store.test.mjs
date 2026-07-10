import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createWorkerStore } from "../src/worker/store.js";

function mode(stat) {
  return stat.mode & 0o777;
}

async function tempStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-worker-store-"));
  const store = createWorkerStore({ codexWorkerStateDir: dir });
  await store.ensure();
  return { dir, store };
}

test("worker store appends job events with monotonic seq", async () => {
  const { store } = await tempStore();
  await store.writeJobState({ id: "job-1", status: "accepted" });
  const first = await store.appendJobEvent("job-1", { type: "worker.job.started" });
  await store.writeJobState({ id: "job-1", status: "running" });
  const second = await store.appendJobEvent("job-1", { type: "item.completed", seq: 99, item: { id: "msg", type: "agent_message", text: "done" } });
  assert.equal(first.seq, 1);
  assert.equal(second.seq, 2);
  assert.deepEqual((await store.readJobEvents("job-1", { afterSeq: 1 })).map((event) => event.seq), [2]);
  assert.equal(mode(await fs.stat(store.paths.stateDir)), 0o700);
  assert.equal(mode(await fs.stat(store.paths.jobsDir)), 0o700);
  assert.equal(mode(await fs.stat(store.paths.eventsDir)), 0o700);
  assert.equal(mode(await fs.stat(path.join(store.paths.jobsDir, "job-1.json"))), 0o600);
  assert.equal(mode(await fs.stat(path.join(store.paths.eventsDir, "job-1.jsonl"))), 0o600);
});

test("worker store serializes concurrent event appends", async () => {
  const { store } = await tempStore();
  await store.writeJobState({ id: "job-1", status: "running" });

  const events = await Promise.all(Array.from({ length: 20 }, (_, index) => (
    store.appendJobEvent("job-1", {
      type: "worker.heartbeat",
      status: "running",
      index
    })
  )));

  const seqs = events.map((event) => event.seq).sort((a, b) => a - b);
  assert.deepEqual(seqs, Array.from({ length: 20 }, (_, index) => index + 1));
  assert.equal((await store.readJobState("job-1")).lastSeq, 20);
  assert.equal((await store.readJobEvents("job-1", { afterSeq: 0, limit: 50 })).length, 20);
});

test("worker store persists active jobs", async () => {
  const { store } = await tempStore();
  await store.upsertActiveJob({ id: "job-1", chatKey: "chat-1", status: "running" });
  assert.equal((await store.readActiveJobs()).jobs["job-1"].chatKey, "chat-1");
  assert.equal(mode(await fs.stat(store.paths.activeJobs)), 0o600);
  await store.removeActiveJob("job-1");
  assert.deepEqual((await store.readActiveJobs()).jobs, {});
});

test("worker store falls back from corrupt active job state", async () => {
  const { dir, store } = await tempStore();
  await fs.writeFile(path.join(dir, "active-jobs.json"), "{bad json", "utf8");
  assert.deepEqual((await store.readActiveJobs()).jobs, {});
  const corruptFiles = await fs.readdir(path.join(dir, "corrupt"));
  assert.equal(corruptFiles.length, 1);
  assert.equal(mode(await fs.stat(path.join(dir, "corrupt"))), 0o700);
  assert.equal(mode(await fs.stat(path.join(dir, "corrupt", corruptFiles[0]))), 0o600);
});
