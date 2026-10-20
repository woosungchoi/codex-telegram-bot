import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createWorkerClient } from "../src/worker/client.js";
import { createWorkerServer } from "../src/worker/server.js";
import { waitForWorkerReady } from "../src/worker/readiness.js";

const ready = { status: "ok", activeJobs: [], runningJobIds: [] };
function clock() {
  let time = 0;
  return { timeoutMs: 1000, pollMs: 100, now: () => time, sleep: async (ms) => { time += ms; } };
}

test("readiness retries only transient status failures while the socket starts", async () => {
  const failures = [Object.assign(new Error("starting"), { code: "ENOENT" }),
    Object.assign(new Error("starting"), { code: "ECONNREFUSED" }),
    Object.assign(new Error("starting"), { localeKey: "errors.workerConnectionClosed" }),
    Object.assign(new Error("starting"), { localeKey: "errors.workerRequestTimeout" })];
  let attempts = 0;
  const status = await waitForWorkerReady({ status: async () => {
    attempts += 1;
    if (failures.length) throw failures.shift();
    return ready;
  } }, clock());
  assert.equal(status, ready);
  assert.equal(attempts, 5);
});

test("readiness stops within its budget and preserves the last socket error", async () => {
  const cause = Object.assign(new Error("connect ENOENT"), { code: "ENOENT" });
  const timing = clock();
  await assert.rejects(waitForWorkerReady({ status: async () => { throw cause; } }, timing), (error) => {
    assert.equal(error.code, "WORKER_NOT_READY");
    assert.equal(error.cause, cause);
    return true;
  });
  assert.equal(timing.now(), 1000);
});

test("readiness does not hide permanent permission errors or invalid handshakes", async () => {
  const error = Object.assign(new Error("permission denied"), { code: "EACCES" });
  await assert.rejects(waitForWorkerReady({ status: async () => { throw error; } }, clock()), (value) => value === error);
  await assert.rejects(waitForWorkerReady({ status: async () => ({ status: "ok" }) }, clock()), /invalid response/);
});

test("readiness deadline also bounds a status request that never returns", async () => {
  await assert.rejects(waitForWorkerReady({ status: () => new Promise(() => {}) }, { timeoutMs: 20 }), { code: "WORKER_NOT_READY" });
});

test("readiness connects when a real worker creates its Unix socket after the first attempt", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "worker-ready-"));
  const config = { codexWorkerStateDir: dir, codexWorkerSocket: path.join(dir, "worker.sock"), codexWorkerConnectTimeoutMs: 100 };
  const worker = createWorkerServer({ config, executeJob: async () => {} });
  let attempts = 0, listening;
  const client = createWorkerClient(config);
  try {
    const result = await waitForWorkerReady({ status: async () => {
      attempts += 1;
      try { return await client.status(); }
      catch (error) {
        if (attempts === 1) listening = worker.listen();
        throw error;
      }
    } }, { timeoutMs: 2000, pollMs: 10 });
    assert.equal(result.status, "ok");
    assert.ok(attempts > 1);
    await listening;
  } finally {
    if (listening) { await listening; await worker.close(); }
    await fs.rm(dir, { recursive: true, force: true });
  }
  t.diagnostic("No production worker or job was restarted.");
});

for (const phase of ['status', 'poll']) {
  test(`readiness cancellation interrupts a pending ${phase} without another probe`, async () => {
    const controller = new AbortController();
    let calls = 0;
    const options = { timeoutMs: 1000, signal: controller.signal };
    if (phase === 'poll') options.sleep = async () => { controller.abort(new Error('cancel wait')); return new Promise(() => {}); };
    const waiting = waitForWorkerReady({ status: async () => {
      calls++;
      if (phase === 'status') { controller.abort(new Error('cancel wait')); return new Promise(() => {}); }
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    } }, options);
    await assert.rejects(waiting, /cancel wait/);
    assert.equal(calls, 1);
  });
}

test('already cancelled readiness performs no RPC', async () => {
  const controller = new AbortController();
  controller.abort(new Error('cancel first'));
  await assert.rejects(waitForWorkerReady({ status() { assert.fail('must not probe'); } }, { signal: controller.signal }), /cancel first/);
});
