import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createWorkerClient } from "../src/worker/client.js";
import { createWorkerServer } from "../src/worker/server.js";
import { isWorkerRestartFailure } from "../src/worker/replay.js";
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
    codexWorkerConnectTimeoutMs: 5000,
    codexTransport: "sdk"
  };
  const store = createWorkerStore(config);
  await prepareStore?.(store);
  const worker = createWorkerServer({ config, store, executeJob, logger: { warn() {} }, ...serverOptions });
  await worker.listen();
  return { config, worker, client: createWorkerClient(config), store };
}

async function readRawJob(store, jobId) {
  return JSON.parse(await fs.readFile(path.join(store.paths.jobsDir, `${jobId}.json`), "utf8"));
}

async function assertRawTerminalFailure(store, jobId, reason) {
  const raw = await readRawJob(store, jobId);
  assert.equal(raw.status, "failed");
  assert.ok(Number.isFinite(Date.parse(raw.completedAt)));
  assert.equal(raw.terminalEvent?.type, "worker.job.failed");
  assert.equal(raw.terminalEvent?.status, "failed");
  assert.equal(raw.lastSeq, raw.terminalEvent.seq);
  assert.equal(raw.failureReason, reason);
  const events = await store.readJobEvents(jobId, { afterSeq: 0 });
  assert.ok(events.some((event) => event.seq === raw.terminalEvent.seq && event.type === "worker.job.failed" && event.reason === reason));
  const log = await fs.readFile(path.join(store.paths.eventsDir, `${jobId}.jsonl`), "utf8");
  assert.ok(log.split("\n").filter(Boolean).map((line) => JSON.parse(line)).some((event) => event.seq === raw.terminalEvent.seq && event.type === "worker.job.failed" && event.reason === reason));
  return raw;
}

test("worker server reports status", async () => {
  const { config, worker, client } = await startServer(async () => {});
  try {
  assert.deepEqual(await client.status(), { status: "ok", capabilities: ["accounts-v1", "log-archive-v1", "questions-v1", "steer-v1"], activeJobs: [], runningJobIds: [] });
    assert.equal(mode(await fs.stat(config.codexWorkerSocket)), 0o600);
  } finally {
    await worker.close();
  }
});

test("worker blocks new jobs during a host update without affecting status queries", async () => {
  let starts = 0;
  const { config, worker, client } = await startServer(async () => { starts += 1; });
  config.codexUpdateDir = path.join(config.codexWorkerStateDir, "codex-update");
  try {
    await fs.mkdir(config.codexUpdateDir);
    await fs.writeFile(path.join(config.codexUpdateDir, "status.json"), JSON.stringify({ phase: "waiting_idle" }));
    await assert.rejects(client.startJob({ id: "blocked", chatKey: "chat" }), /new jobs are paused/);
    assert.equal(starts, 0);
    assert.equal((await client.status()).activeJobs.length, 0);
    await fs.writeFile(path.join(config.codexUpdateDir, "status.json"), JSON.stringify({ phase: "succeeded" }));
    await client.startJob({ id: "allowed", chatKey: "chat" });
    assert.equal(starts, 1);
  } finally { await worker.close(); }
});

test("worker server writes heartbeat events for running jobs", async () => {
  const executeJob = async ({ signal }) => {
    if (!signal.aborted) {
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    }
  };
  const { worker, client } = await startServer(executeJob, { heartbeatMs: 20 });
  try {
    await client.startJob({ id: "job-heartbeat", chatKey: "chat-heartbeat", inputText: "hi" });
    await new Promise((resolve) => setTimeout(resolve, 60));
    const events = await client.readJobEvents("job-heartbeat", 0);
    assert.equal(events.events.some((event) => event.type === "worker.heartbeat"), true);
    await client.cancelJob("job-heartbeat");
  } finally {
    await worker.close();
  }
});

test("worker server survives socket errors and a client disconnect before a response is ready", async (t) => {
  let releaseRead;
  const readGate = new Promise((resolve) => {
    releaseRead = resolve;
  });
  t.after(() => releaseRead());
  const { config, worker, client } = await startServer(async () => {}, {
    prepareStore: async (store) => {
      const readJobEvents = store.readJobEvents;
      store.readJobEvents = async (...args) => {
        await readGate;
        return readJobEvents(...args);
      };
    }
  });
  try {
    const socketErrorResult = new Promise((resolve) => {
      worker.server.once("connection", (socket) => {
        try {
          socket.emit("error", Object.assign(new Error("injected reset"), { code: "ECONNRESET" }));
          resolve(null);
        } catch (error) {
          resolve(error);
        }
      });
    });
    const impatientClient = createWorkerClient({
      ...config,
      codexWorkerConnectTimeoutMs: 5
    });
    await assert.rejects(
      () => impatientClient.readJobEvents("job-disconnected", 0),
      /worker request timed out/
    );
    assert.equal(await socketErrorResult, null);
    releaseRead();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal((await client.status()).status, "ok");
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
  let starts = 0;
  const { worker, client, store } = await startServer(async () => { starts += 1; }, {
    prepareStore: async (preparedStore) => {
      await preparedStore.writeJobState({ id: "job-orphan", chatKey: "chat-orphan", status: "running" });
      await preparedStore.upsertActiveJob({ id: "job-orphan", chatKey: "chat-orphan", status: "running" });
    }
  });
  try {
  assert.deepEqual(await client.status(), { status: "ok", capabilities: ["accounts-v1", "log-archive-v1", "questions-v1", "steer-v1"], activeJobs: [], runningJobIds: [] });
    assert.equal((await store.readJobState("job-orphan")).status, "failed");
    assert.equal((await store.readJobState("job-orphan")).failureReason, "worker_restart");
    assert.equal(
      (await store.readJobState("job-orphan")).error,
      "worker restarted before job completed"
    );
    const events = await store.readJobEvents("job-orphan", { afterSeq: 0 });
    assert.equal(events.at(-1).type, "worker.job.failed");
    assert.equal(events.at(-1).reason, "worker_restart");
    const raw = await assertRawTerminalFailure(store, "job-orphan", "worker_restart");
    assert.equal(raw.error, "worker restarted before job completed");
    assert.deepEqual((await store.readActiveJobs()).jobs, {});
    assert.equal(starts, 0);
  } finally {
    await worker.close();
  }
});

for (const [reason, interruptedState] of [
  ["question_interrupted", { userQuestion: { state: "pending" } }],
  ["steer_interrupted", { steers: { steer1: { state: "pending" } } }]
]) {
  test(`worker startup preserves ${reason} terminal evidence`, async () => {
    let starts = 0;
    const jobId = `job-${reason}`;
    const { worker, client, store } = await startServer(async () => { starts += 1; }, {
      prepareStore: async (preparedStore) => {
        await preparedStore.writeJobState({ id: jobId, chatKey: `chat-${reason}`, status: "running", ...interruptedState });
        await preparedStore.upsertActiveJob({ id: jobId, chatKey: `chat-${reason}`, status: "running" });
      }
    });
    try {
      const raw = await assertRawTerminalFailure(store, jobId, reason);
      assert.ok(raw.error);
      assert.deepEqual((await client.status()).activeJobs, []);
      assert.deepEqual((await store.readActiveJobs()).jobs, {});
      assert.equal(starts, 0);
    } finally {
      await worker.close();
    }
  });
}

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

const waitForAbort = async ({ signal }) => {
  if (!signal.aborted) await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
};

test("a read barrier cannot admit two simultaneous requests for the same chat", async (t) => {
  let starts = 0, reads = 0, release, entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const firstRead = new Promise((resolve) => { entered = resolve; });
  t.after(() => release());
  const { worker, client, store } = await startServer(async (args) => { starts += 1; await waitForAbort(args); });
  const read = store.readActiveJobs;
  store.readActiveJobs = async () => {
    const snapshot = await read();
    reads += 1;
    entered();
    await gate;
    return snapshot;
  };
  try {
    const first = client.startJob({ id: "race-a", chatKey: "same" });
    await firstRead;
    const second = client.startJob({ id: "race-b", chatKey: "same" });
    // Both sockets can dispatch while the first store read is paused. Admission
    // serializes the read/check/reservation, rather than only the final write.
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(reads, 1);
    release();
    const results = await Promise.allSettled([first, second]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.match(results.find((r) => r.status === "rejected").reason.message, /Active worker job already exists/);
    assert.equal(starts, 1);
  } finally { release(); await worker.close(); }
});

test("different chats run concurrently and same-ID retries execute once", async () => {
  let starts = 0;
  const { worker, client, store } = await startServer(async (args) => { starts += 1; await waitForAbort(args); });
  try {
    const job = { id: "idempotent", chatKey: "chat-a", inputText: "한🙂" };
    const [a, retry, b] = await Promise.all([
      client.startJob(job), client.startJob({ inputText: "한🙂", chatKey: "chat-a", id: "idempotent" }),
      client.startJob({ id: "parallel", chatKey: "chat-b" })
    ]);
    assert.deepEqual(a, retry);
    assert.equal(b.status, "accepted");
    assert.equal(starts, 2);
    assert.equal((await client.status()).runningJobIds.length, 2);
    assert.equal((await store.readJobEvents(job.id)).filter((e) => e.type === "worker.job.accepted").length, 1);
    await assert.rejects(client.startJob({ ...job, inputText: "different" }), /different request/);
    await assert.rejects(client.startJob({ ...job, chatKey: "chat-c" }), /different request/);
  } finally { await worker.close(); }
});

test("completed same-ID retries return the persisted result without executing again", async () => {
  let starts = 0, finished;
  const completion = new Promise((resolve) => { finished = resolve; });
  const { worker, client } = await startServer(async ({ store, job }) => {
    starts += 1;
    await store.appendJobEvent(job.id, { type: "worker.job.completed", status: "completed" });
    finished();
  });
  const job = { id: "complete-retry", chatKey: "chat" };
  try {
    await client.startJob(job);
    await completion;
    assert.deepEqual(await client.startJob(job), { jobId: job.id, status: "completed" });
    assert.equal(starts, 1);
  } finally { await worker.close(); }
});

test("admission failures rollback without executing and allow a new ID", async () => {
  for (const scenario of ["writeJobState", "upsertActiveJob", "appendJobEvent", "appendCommitted"]) {
    const operation = scenario === "appendCommitted" ? "appendJobEvent" : scenario;
    let starts = 0;
    const { worker, client, store } = await startServer(async (args) => { starts += 1; await waitForAbort(args); });
    const original = store[operation];
    let fail = true;
    store[operation] = async (...args) => {
      if (fail) {
        fail = false;
        if (scenario === "appendCommitted") await original(...args);
        throw new Error(`injected ${operation} failure`);
      }
      return original(...args);
    };
    try {
      const job = { id: `failed-${operation}`, chatKey: "chat" };
      await assert.rejects(client.startJob(job), /injected/);
      assert.equal(starts, 0);
      assert.deepEqual((await store.readActiveJobs()).jobs, {});
      const raw = await assertRawTerminalFailure(store, job.id, "worker_admission");
      assert.equal(raw.chatKey, "chat");
      assert.equal((await client.startJob(job)).status, "failed");
      await client.startJob({ id: `recovered-${operation}`, chatKey: "chat" });
      assert.equal(starts, 1);
    } finally { await worker.close(); }
  }
});

test("failed terminal publication keeps the admission reservation and blocks further work", async () => {
  let starts = 0;
  const { config, worker, client, store } = await startServer(async () => { starts += 1; });
  const append = store.appendJobEvent;
  store.appendJobEvent = async (jobId, event) => {
    if (event.type === "worker.job.accepted") {
      await append(jobId, event);
      throw new Error("injected committed acceptance response failure");
    }
    if (event.type === "worker.job.failed") throw new Error("injected terminal publication failure");
    return append(jobId, event);
  };
  try {
    await assert.rejects(client.startJob({ id: "terminal-publication-failure", chatKey: "chat" }), /recovery is required/);
    assert.equal(starts, 0);
    const raw = await readRawJob(store, "terminal-publication-failure");
    assert.equal(raw.status, "accepted");
    assert.equal(raw.terminalEvent, undefined);
    assert.deepEqual(Object.keys((await store.readActiveJobs()).jobs), ["terminal-publication-failure"]);
    await assert.rejects(client.startJob({ id: "blocked-after-terminal-failure", chatKey: "another" }), /recovery is required/);
    await assert.rejects(client.status(), /recovery is required/);
  } finally {
    await worker.close();
    store.appendJobEvent = append;
  }
  const recovered = createWorkerServer({ config, store, executeJob: async () => { starts += 1; }, logger: { warn() {} } });
  await recovered.listen();
  try {
    const raw = await assertRawTerminalFailure(store, "terminal-publication-failure", "worker_restart");
    assert.equal(raw.error, "worker restarted before job completed");
    assert.deepEqual((await store.readActiveJobs()).jobs, {});
    assert.equal((await client.startJob({ id: "terminal-publication-failure", chatKey: "chat" })).status, "failed");
    assert.equal(starts, 0);
    await client.startJob({ id: "after-recovery", chatKey: "another" });
    assert.equal(starts, 1);
  } finally {
    await recovered.close();
  }
});

test("unreadable active index blocks admission/status without overwriting and resumes after repair", async (t) => {
  let starts = 0;
  const { worker, client, store } = await startServer(async (args) => { starts += 1; await waitForAbort(args); });
  const read = fs.readFile;
  const before = await read(store.paths.activeJobs, "utf8");
  let code = "EACCES";
  const mock = t.mock.method(fs, "readFile", async (target, ...args) => {
    if (target === store.paths.activeJobs && code) throw Object.assign(new Error(`injected ${code}`), { code });
    return read(target, ...args);
  });
  try {
    for (code of ["EACCES", "EIO"]) {
      await assert.rejects(client.startJob({ id: code, chatKey: "chat" }), /injected/);
      await assert.rejects(client.status(), /injected/);
      assert.equal(await read(store.paths.activeJobs, "utf8"), before);
      assert.equal(starts, 0);
    }
    code = "";
    await client.startJob({ id: "repaired", chatKey: "chat" });
    assert.equal(starts, 1);
  } finally { mock.mock.restore(); await worker.close(); }
});

test("startup reconstructs a reservation interrupted before active-index registration", async () => {
  let starts = 0;
  const { worker, client, store } = await startServer(async () => { starts += 1; }, {
    prepareStore: async (prepared) => {
      await prepared.readActiveJobs();
      await prepared.writeJobState({ id: "interrupted", chatKey: "chat", status: "accepted" });
    }
  });
  try {
    assert.equal((await store.readJobState("interrupted")).failureReason, "worker_restart");
    assert.deepEqual((await client.status()).activeJobs, []);
    assert.equal(starts, 0);
  } finally { await worker.close(); }
});

test("failed rollback blocks subsequent admission until healthy startup recovery", async () => {
  let starts = 0;
  const { config, worker, client, store } = await startServer(async () => { starts += 1; });
  const write = store.writeJobState;
  store.upsertActiveJob = async () => { throw new Error("injected reservation failure"); };
  store.writeJobState = async (job) => {
    if (job.failureReason === "worker_admission") throw new Error("injected rollback failure");
    return write(job);
  };
  try {
    await assert.rejects(client.startJob({ id: "uncertain", chatKey: "chat" }), /recovery is required/);
    await assert.rejects(client.startJob({ id: "blocked", chatKey: "another" }), /recovery is required/);
    await assert.rejects(client.status(), /recovery is required/);
    assert.equal(starts, 0);
  } finally { await worker.close(); }
  const restarted = createWorkerServer({ config, executeJob: async () => { starts += 1; }, logger: { warn() {} } });
  await restarted.listen();
  try {
    const uncertain = await store.readJobState("uncertain");
    assert.equal(uncertain.status, "failed");
    assert.equal(uncertain.terminalEvent?.reason, "worker_admission");
    assert.equal(uncertain.failureReason, undefined);
    assert.deepEqual((await store.readActiveJobs()).jobs, {});
    assert.equal(starts, 0);
    await client.startJob({ id: "healthy", chatKey: "chat" });
    assert.equal(starts, 1);
  } finally { await restarted.close(); }
});

test("live controller reservations survive an index replaced with empty valid JSON", async () => {
  let starts = 0;
  const { worker, client, store } = await startServer(async (args) => { starts += 1; await waitForAbort(args); });
  try {
    await client.startJob({ id: "live-controller", chatKey: "chat" });
    await fs.writeFile(store.paths.activeJobs, JSON.stringify({ version: 1, jobs: {} }));
    await assert.rejects(client.startJob({ id: "duplicate-controller", chatKey: "chat" }), /Active worker job already exists/);
    await assert.rejects(client.startJob({ id: "unsafe/id", chatKey: "other" }), /safe job ID/);
    assert.equal(starts, 1);
  } finally { await worker.close(); }
});

test("worker questions RPC waits for answers and survives frontend reconnection", async () => {
  let finished = false;
  const { config, worker, client } = await startServer(async ({ signal }) => {
    await new Promise((r) => signal.addEventListener("abort", r, { once: true }));
  });
  try {
    await client.startJob({ id: "questions", chatKey: "chat", requesterUserId: "42" });
    const pending = client.askQuestions("questions", [{ id: "a", question: "Choose", options: [{ label: "Yes" }, { label: "No" }] }]).then((x) => { finished = true; return x; });
    let q;
    for (let i = 0; i < 100 && !q; i++) { q = await client.currentQuestion("chat"); await new Promise((r) => setTimeout(r, 5)); }
    assert.ok(q);
    assert.equal(finished, false);
    const replacement = createWorkerClient(config);
    assert.equal((await replacement.currentQuestion("chat")).id, q.id);
    await replacement.answerQuestion({ jobId: q.jobId, questionId: q.id, index: 0, userId: "42", chatKey: "chat", option: 0 });
    assert.deepEqual(await pending, { answers: { a: { answers: ["Yes"] } } });
  } finally { await worker.close(); }
});

test("worker restart does not arm automatic execution for an interrupted question", async () => {
  const { worker, client } = await startServer(async () => {}, { prepareStore: async (store) => {
    await store.writeJobState({ id: "waiting", chatKey: "chat", status: "running", userQuestion: { state: "pending" } });
    await store.upsertActiveJob({ id: "waiting", chatKey: "chat", status: "running" });
  } });
  try {
    assert.equal((await client.getJobStatus("waiting")).job.failureReason, "question_interrupted");
    assert.equal(isWorkerRestartFailure((await client.getJobStatus("waiting")).job), false);
    assert.equal((await client.readJobEvents("waiting")).events.at(-1).reason, "question_interrupted");
  } finally { await worker.close(); }
});

test('worker steering RPC reaches the live turn once and persists its delivery result', async () => {
  let calls=0;
  const {worker,client,store}=await startServer(async ({job,signal,onSteerReady})=>{
    await store.writeJobState({...job,status:'running'});
    const release=onSteerReady({threadId:'thread',turnId:'turn',steer:async()=>{calls++;return {status:'accepted'};}});
    await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));release();
  });
  try {
    await client.startJob({id:'steer-job',chatKey:'chat',requesterUserId:'7',inputText:'start'});
    for(let i=0;i<50 && (await store.readJobState('steer-job')).status!=='running';i++) await new Promise(r=>setTimeout(r,10));
    const input={jobId:'steer-job',requestId:'q',chatKey:'chat',userId:'7',inputText:'focus on B'};
    assert.equal((await client.steerJob(input)).status,'accepted');
    assert.equal((await client.steerJob(input)).status,'accepted');assert.equal(calls,1);
    await client.cancelJob('steer-job');
  } finally {await worker.close();}
});

test('orphaned steered jobs are not replayed with the uncorrected original prompt',async()=>{
  const {worker,client}=await startServer(async()=>{}, {prepareStore:async store=>{
    await store.ensure();const job={id:'steered-orphan',chatKey:'chat',status:'running',steers:{q:{status:'sending'}}};
    await store.writeJobState(job);await store.upsertActiveJob(job);
  }});
  try {
    const {job}=await client.getJobStatus('steered-orphan');
    assert.equal(job.failureReason,'steer_interrupted');assert.equal(isWorkerRestartFailure(job),false);
  }finally{await worker.close();}
});
