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

test("terminal event publication reserves a timestamp and recovers an interrupted append", async () => {
  const { store } = await tempStore();
  for (const [status, type] of [
    ["completed", "worker.job.completed"],
    ["failed", "worker.job.failed"],
    ["cancelled", "worker.job.cancelled"]
  ]) {
    const id = `terminal-${status}`;
    const event = await store.appendJobEvent(id, { type, status, chatKey: "chat" });
    const job = await store.readJobState(id);
    assert.equal(job.status, status);
    assert.ok(Number.isFinite(Date.parse(job.completedAt)));
    assert.equal(job.completedAt, event.completedAt);
    assert.equal(job.lastSeq, event.seq);
    assert.equal((await store.readJobEvents(id)).at(-1).seq, job.lastSeq);
  }

  const completedAt = "2026-10-06T04:47:05.000Z";
  await store.writeJobState({
    id: "interrupted-terminal",
    status: "completed",
    completedAt,
    lastSeq: 1,
    terminalEvent: {
      seq: 1,
      type: "worker.job.completed",
      status: "completed",
      completedAt,
      at: completedAt
    }
  });
  assert.deepEqual(await store.readJobEvents("interrupted-terminal"), [
    {
      seq: 1,
      type: "worker.job.completed",
      status: "completed",
      completedAt,
      at: completedAt
    }
  ]);
});

test("terminal replay includes valid JSON without its final newline exactly once", async (t) => {
  const { dir, store } = await tempStore();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const status of ["completed", "failed", "cancelled"]) {
    const id = `tail-${status}`;
    await store.appendJobEvent(id, { type: "worker.job.started", status: "running" });
    const terminal = await store.appendJobEvent(id, { type: `worker.job.${status}`, status });
    const file = path.join(store.paths.eventsDir, `${id}.jsonl`);
    const complete = await fs.readFile(file, "utf8");
    // Simulate a crash after the terminal JSON bytes but before its delimiter.
    await fs.writeFile(file, complete.slice(0, -1));
    const restarted = createWorkerStore({ codexWorkerStateDir: dir });
    assert.equal((await restarted.readJobState(id)).lastSeq, terminal.seq);
    assert.deepEqual((await restarted.readJobEvents(id)).map((event) => event.seq), [1, 2]);
    assert.deepEqual(await restarted.readJobEvents(id, { afterSeq: 1, limit: 1 }), [terminal]);
    assert.deepEqual(await restarted.readJobEvents(id, { afterSeq: 2 }), []);
    assert.deepEqual(await restarted.readJobEvents(id, { limit: 0 }), []);
    assert.deepEqual((await restarted.readJobEvents(id, { limit: 1 })).map((event) => event.seq), [1]);
    await fs.appendFile(file, "\n");
    assert.deepEqual(await restarted.readJobEvents(id, { afterSeq: 1 }), [terminal]);
  }
});

test("late events cannot reopen a terminal job or change its final cursor", async (t) => {
  const { dir, store } = await tempStore();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const interrupted of [false, true]) {
    const id = `late-${interrupted}`;
    await store.writeJobState({ id, chatKey: "chat", acceptedAt: "2020-01-01T00:00:00.000Z", status: "running" });
    const terminal = await store.appendJobEvent(id, { type: "worker.job.completed", status: "completed" });
    const file = path.join(store.paths.eventsDir, `${id}.jsonl`);
    if (interrupted) await fs.truncate(file, 0);
    const before = await fs.readFile(file, "utf8");
    const job = await store.readJobState(id);
    for (const type of ["worker.heartbeat", "worker.job.cancel.requested", "worker.steer", "worker.job.failed"]) {
      await assert.rejects(store.appendJobEvent(id, { type, status: "running" }), /Terminal worker jobs/);
    }
    assert.deepEqual(await store.readJobState(id), job);
    assert.equal(await fs.readFile(file, "utf8"), before);
    assert.deepEqual(await store.readJobEvents(id), [terminal]);
  }
});

test("worker store ignores only an incomplete trailing event until it is complete", async () => {
  const { store } = await tempStore();
  const first = JSON.stringify({ seq: 1, type: "worker.job.started" });
  const second = JSON.stringify({
    seq: 2,
    type: "item.completed",
    item: { id: "msg", type: "agent_message", text: "a long response" }
  });
  const splitAt = second.indexOf("long");
  const eventFile = path.join(store.paths.eventsDir, "job-1.jsonl");
  await fs.writeFile(eventFile, `${first}\n${second.slice(0, splitAt)}`, "utf8");

  assert.deepEqual(
    (await store.readJobEvents("job-1", { afterSeq: 0 })).map((event) => event.seq),
    [1]
  );

  await fs.appendFile(eventFile, `${second.slice(splitAt)}\n`, "utf8");
  assert.deepEqual(
    (await store.readJobEvents("job-1", { afterSeq: 0 })).map((event) => event.seq),
    [1, 2]
  );
});

test("worker store rejects malformed completed event records", async () => {
  const { store } = await tempStore();
  const eventFile = path.join(store.paths.eventsDir, "job-1.jsonl");
  await fs.writeFile(eventFile, '{"seq":1,"type":"broken"\n', "utf8");

  await assert.rejects(
    () => store.readJobEvents("job-1", { afterSeq: 0 }),
    /JSON/
  );
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

test("event log repairs lastSeq after append commits and state rename fails", async (t) => {
  const { dir, store } = await tempStore();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await store.writeJobState({ id: "fault", chatKey: "chat", status: "accepted" });
  const rename = fs.rename;
  let fail = true;
  t.mock.method(fs, "rename", async (from, to) => {
    if (to === path.join(store.paths.jobsDir, "fault.json") && fail) {
      fail = false;
      throw Object.assign(new Error("injected state EIO"), { code: "EIO" });
    }
    return rename(from, to);
  });
  await assert.rejects(store.appendJobEvent("fault", { type: "worker.job.started" }), { code: "EVENT_COMMITTED", committedSeq: 1 });
  assert.equal(JSON.parse(await fs.readFile(path.join(store.paths.jobsDir, "fault.json"))).lastSeq, undefined);
  const restarted = createWorkerStore({ codexWorkerStateDir: dir });
  assert.equal((await restarted.readJobState("fault")).lastSeq, 1);
  assert.equal((await restarted.readJobState("fault")).status, "running");
  assert.equal((await restarted.appendJobEvent("fault", { type: "item.completed", text: "한🙂" })).seq, 2);
  assert.deepEqual((await restarted.readJobEvents("fault", { afterSeq: 1 })).map((e) => e.seq), [2]);
  assert.equal((await restarted.readJobState("fault")).lastSeq, 2);
});

test("partial records are preserved in quarantine then trimmed before append", async (t) => {
  const { dir, store } = await tempStore();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await store.writeJobState({ id: "tail", status: "running" });
  await store.appendJobEvent("tail", { type: "worker.job.started" });
  const file = path.join(store.paths.eventsDir, "tail.jsonl");
  for (const tail of [Buffer.from('{"seq":2,"text":"🙂').subarray(0, -2), Buffer.from('{"seq":99}')]) {
    await fs.appendFile(file, tail);
    const restarted = createWorkerStore({ codexWorkerStateDir: dir });
    const before = await restarted.readJobState("tail");
    const cursor = before.lastSeq;
    assert.deepEqual(await restarted.readJobEvents("tail", { afterSeq: cursor }), []);
    const next = await restarted.appendJobEvent("tail", { type: "worker.heartbeat", status: "running" });
    assert.equal(next.seq, cursor + 1);
    assert.deepEqual((await restarted.readJobEvents("tail", { afterSeq: cursor })).map((e) => e.seq), [cursor + 1]);
  }
  assert.equal((await fs.readdir(store.paths.corruptDir)).length, 2);
});

test("completed duplicate event sequences block appends without rewriting the log", async (t) => {
  const { dir, store } = await tempStore();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(store.paths.eventsDir, "duplicate.jsonl");
  const original = '{"seq":1}\n{"seq":1}\n';
  await fs.writeFile(file, original);
  await assert.rejects(store.appendJobEvent("duplicate", { type: "worker.heartbeat" }), { code: "EWORKERSTATE" });
  assert.equal(await fs.readFile(file, "utf8"), original);
});

test("ENOENT rebuilds active jobs, JSON corruption preserves jobs and cursor", async (t) => {
  const { dir, store } = await tempStore();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  assert.deepEqual((await store.readActiveJobs()).jobs, {});
  await store.writeJobState({ id: "live", chatKey: "chat", status: "running" });
  await store.appendJobEvent("live", { type: "worker.job.started", status: "running" });
  for (const damage of ["missing", "syntax", "shape"]) {
    if (damage === "missing") await fs.rm(store.paths.activeJobs);
    else await fs.writeFile(store.paths.activeJobs, damage === "syntax" ? "{bad" : '{"jobs":[]}');
    const restarted = createWorkerStore({ codexWorkerStateDir: dir });
    const active = await restarted.readActiveJobs();
    assert.equal(active.jobs.live.chatKey, "chat");
    assert.equal(active.jobs.live.lastSeq, 1);
    assert.deepEqual((await restarted.readJobEvents("live")).map((e) => e.seq), [1]);
  }
});

test("EACCES/EIO reads propagate and cannot overwrite active or job files", async (t) => {
  const { dir, store } = await tempStore();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await store.writeJobState({ id: "live", chatKey: "chat", status: "running" });
  await store.upsertActiveJob({ id: "live", chatKey: "chat", status: "running" });
  const readFile = fs.readFile;
  for (const file of [store.paths.activeJobs, path.join(store.paths.jobsDir, "live.json")]) {
    const before = await readFile(file, "utf8");
    for (const code of ["EACCES", "EIO"]) {
      const mock = t.mock.method(fs, "readFile", async (target, ...args) => {
        if (target === file) throw Object.assign(new Error(`injected ${code}`), { code });
        return readFile(target, ...args);
      });
      const action = file === store.paths.activeJobs ? () => store.upsertActiveJob({ id: "new", chatKey: "new", status: "accepted" }) : () => store.writeJobState({ id: "live", status: "completed" });
      await assert.rejects(action, { code });
      mock.mock.restore();
      assert.equal(await readFile(file, "utf8"), before);
    }
  }
});

test("quarantine rename and recovery write failures preserve original and resume safely", async (t) => {
  const { dir, store } = await tempStore();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await store.writeJobState({ id: "live", chatKey: "chat", status: "running" });
  await fs.writeFile(store.paths.activeJobs, "{bad");
  const rename = fs.rename;
  for (const failure of ["quarantine", "index"]) {
    const mock = t.mock.method(fs, "rename", async (from, to) => {
      if (failure === "quarantine" ? String(to).endsWith(".corrupt") : to === store.paths.activeJobs) {
        throw Object.assign(new Error("injected rename EIO"), { code: "EIO" });
      }
      return rename(from, to);
    });
    await assert.rejects(store.readActiveJobs(), { code: "EIO" });
    mock.mock.restore();
    assert.equal(await fs.readFile(store.paths.activeJobs, "utf8"), "{bad");
  }
  assert.equal((await createWorkerStore({ codexWorkerStateDir: dir }).readActiveJobs()).jobs.live.status, "running");
});

test("corrupt job state blocks reconstruction and repeated writes until explicitly repaired", async (t) => {
  const { dir, store } = await tempStore();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(store.paths.jobsDir, "live.json");
  await fs.writeFile(file, "{bad");
  await fs.writeFile(store.paths.activeJobs, "{bad index");
  for (const action of [() => store.readActiveJobs(), () => store.writeJobState({ id: "live", status: "accepted" }), () => store.writeJobState({ id: "live", status: "accepted" })]) {
    await assert.rejects(action, { code: "EWORKERSTATE" });
    assert.equal(await fs.readFile(file, "utf8"), "{bad");
    assert.equal(await fs.readFile(store.paths.activeJobs, "utf8"), "{bad index");
  }
  await fs.writeFile(file, JSON.stringify({ id: "live", chatKey: "chat", status: "running" }));
  assert.equal((await store.readActiveJobs()).jobs.live.status, "running");
});

test("JSON null is corruption, never an ENOENT fallback for an existing job", async (t) => {
  const { dir, store } = await tempStore();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(store.paths.jobsDir, "null-job.json");
  await fs.writeFile(file, "null");
  await assert.rejects(store.writeJobState({ id: "null-job", status: "accepted" }), { code: "EWORKERSTATE" });
  assert.equal(await fs.readFile(file, "utf8"), "null");
});

test("an interrupted recovery retries from job files when the index is still absent", async (t) => {
  const { dir, store } = await tempStore();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await store.writeJobState({ id: "live", chatKey: "chat", status: "running" });
  const rename = fs.rename;
  const mock = t.mock.method(fs, "rename", async (from, to) => {
    if (to === store.paths.activeJobs) throw Object.assign(new Error("injected EIO"), { code: "EIO" });
    return rename(from, to);
  });
  await assert.rejects(store.readActiveJobs(), { code: "EIO" });
  mock.mock.restore();
  assert.equal((await createWorkerStore({ codexWorkerStateDir: dir }).readActiveJobs()).jobs.live.status, "running");
});

test("failed partial-log quarantine never trims bytes, and recovery can restart before append", async (t) => {
  const { dir, store } = await tempStore();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await store.writeJobState({ id: "recover", status: "running" });
  await store.appendJobEvent("recover", { type: "worker.job.started" });
  const file = path.join(store.paths.eventsDir, "recover.jsonl");
  await fs.appendFile(file, '{"seq":2,"text":"partial');
  const before = await fs.readFile(file, "utf8"), rename = fs.rename;
  const failedQuarantine = t.mock.method(fs, "rename", async (from, to) => {
    if (String(to).endsWith(".corrupt")) throw Object.assign(new Error("injected EACCES"), { code: "EACCES" });
    return rename(from, to);
  });
  await assert.rejects(store.appendJobEvent("recover", { type: "worker.heartbeat" }), { code: "EACCES" });
  failedQuarantine.mock.restore();
  assert.equal(await fs.readFile(file, "utf8"), before);
  const open = fs.open;
  const interruptedAppend = t.mock.method(fs, "open", async (target, flags, ...args) => {
    if (target === file && flags === "a") throw Object.assign(new Error("injected EIO"), { code: "EIO" });
    return open(target, flags, ...args);
  });
  await assert.rejects(store.appendJobEvent("recover", { type: "worker.heartbeat" }), { code: "EIO" });
  interruptedAppend.mock.restore();
  const restarted = createWorkerStore({ codexWorkerStateDir: dir });
  assert.equal((await restarted.appendJobEvent("recover", { type: "worker.heartbeat" })).seq, 2);
  assert.deepEqual((await restarted.readJobEvents("recover", { afterSeq: 1 })).map((e) => e.seq), [2]);
});

test("a truncated or missing ledger cannot reuse sequence numbers below a persisted cursor", async (t) => {
  const { dir, store } = await tempStore();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await store.writeJobState({ id: "lost", status: "running" });
  await store.appendJobEvent("lost", { type: "worker.job.started" });
  const file = path.join(store.paths.eventsDir, "lost.jsonl");
  const original = await fs.readFile(path.join(store.paths.jobsDir, "lost.json"), "utf8");
  await fs.truncate(file, 0);
  for (const exists of [true, false]) {
    if (!exists) await fs.rm(file);
    await assert.rejects(store.readJobState("lost"), /behind the persisted cursor/);
    await assert.rejects(store.appendJobEvent("lost", { type: "worker.heartbeat" }), /behind the persisted cursor/);
    assert.equal(await fs.readFile(path.join(store.paths.jobsDir, "lost.json"), "utf8"), original);
  }
});
