import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  appendPrivateFile,
  ensurePrivateDirectory,
  hardenPrivateTree,
  writePrivateFileAtomic
} from "../fs/private.js";
import { workerPaths } from "./paths.js";
import { deliveryReceipt, readArchivedEvents } from "./log_retention.js";
import { createEventLogReader } from "./event_log.js";

const STATE_VERSION = 1;
const MISSING = Symbol("missing worker file");
const fileLocks = new Map();
const readEventLog = createEventLogReader();

export async function ensureWorkerStateDir(paths) {
  await ensurePrivateDirectory(paths.stateDir);
  await ensurePrivateDirectory(paths.jobsDir);
  await ensurePrivateDirectory(paths.eventsDir);
}

export function createWorkerStore(config = {}) {
  const paths = workerPaths(config);
  return {
    paths,
    ensure: () => ensureWorkerStateDir(paths),
    appendJobEvent: (jobId, event) => appendJobEvent(paths, jobId, event),
    readJobEvents: (jobId, options) => readJobEvents(paths, jobId, options),
    writeJobState: (job) => writeJobState(paths, job),
    readJobState: (jobId) => readJobState(paths, jobId),
    readActiveJobs: () => readActiveJobs(paths),
    recoverActiveJobs: () => withFileLock(paths.activeJobs, () => readActiveJobsLocked(paths, { rebuild: true })),
    withAdmissionLock: (action) => withFileLock(`${paths.activeJobs}:admission`, action),
    // Maintenance runs these together under the same lock as append/start.
    withJobLock: (id, action) => withFileLock(jobPath(paths, id), action),
    writeJobStateLocked: (job) => writeJobStateLocked(paths, job),
    readJobStateLocked: (jobId) => readJobStateUnlocked(paths, jobId),
    confirmDelivery: (entry) => withFileLock(jobPath(paths, entry?.jobId), async () => {
      const job = await readJobStateUnlocked(paths, entry?.jobId);
      const receipt = deliveryReceipt(job, entry);
      if (!receipt) return { recorded: false };
      await writeJobStateLocked(paths, { id: job.id, deliveryReceipt: receipt });
      return { recorded: true };
    }),
    upsertActiveJob: (job) => upsertActiveJob(paths, job),
    removeActiveJob: (jobId) => removeActiveJob(paths, jobId)
  };
}

export async function appendJobEvent(paths, jobId, event) {
  return withFileLock(jobPath(paths, jobId), async () => {
    await ensureWorkerStateDir(paths);
    const job = await readJobStateUnlocked(paths, jobId);
    if (job?.eventArchive) throw new Error("Archived worker jobs are immutable; use a new job ID.");
    // An already queued heartbeat/control callback may outlive execution.
    // Preserve the terminal cursor, including a state-only interrupted commit.
    if (terminalStatusFromJob(job?.status) && terminalStatusFromEvent(job?.terminalEvent)) {
      throw new Error("Terminal worker jobs cannot accept new events; use a new job ID.");
    }
    const ledger = await inspectJobEvents(paths, jobId);
    if (!ledger.monotonic) throw stateError(jobEventsPath(paths, jobId), "Event sequences are not unique and increasing.");
    if (ledger.size !== ledger.completeBytes) {
      // A newline commits a record. Preserve an interrupted write before trimming it.
      await quarantineCorruptFile(jobEventsPath(paths, jobId), paths.corruptDir);
      await fs.truncate(jobEventsPath(paths, jobId), ledger.completeBytes);
    }
    const seq = ledger.lastSeq + 1;
    if (!Number.isSafeInteger(seq)) throw new Error("Worker event sequence exhausted.");
    const terminalStatus = terminalStatusFromEvent(event);
    const payload = {
      ...event,
      seq,
      at: event.at || new Date().toISOString()
    };
    if (terminalStatus) {
      payload.completedAt = validTimestamp(event.completedAt)
        ? event.completedAt
        : validTimestamp(payload.at)
          ? payload.at
          : new Date().toISOString();
      // Publish status, timestamp, and final sequence before the terminal event.
      const terminalJob = {
        ...(job ?? {}),
        id: jobId,
        status: terminalStatus,
        completedAt: payload.completedAt,
        terminalEvent: payload,
        lastSeq: seq,
        updatedAt: payload.at
      };
      for (const key of ["chatKey", "threadId", "accountId", "kind", "transport"]) {
        if (event[key] !== undefined) terminalJob[key] = event[key];
      }
      await writeJobStateLocked(paths, terminalJob);
    }
    await appendPrivateFile(jobEventsPath(paths, jobId), `${JSON.stringify(payload)}\n`, "utf8");
    if (terminalStatus) return payload;
    try {
      await writeJobStateLocked(paths, {
        ...(job ?? {}),
        id: jobId,
        lastSeq: seq,
        updatedAt: payload.at,
        status: event.status || statusFromEvent(event.type) || job?.status || ""
      });
    } catch (cause) {
      const error = new Error(`Worker event ${seq} was committed but job state needs recovery.`, { cause });
      error.code = "EVENT_COMMITTED";
      error.committedSeq = seq;
      throw error;
    }
    return payload;
  });
}

export async function readJobEvents(paths, jobId, options = {}) {
  return withFileLock(jobPath(paths, jobId), async () => {
    const job = await readJobStateUnlocked(paths, jobId);
    let events;
    try {
      const ledger = await readEventLog.inspect(jobEventsPath(paths, jobId));
      if (!ledger.monotonic) throw stateError(jobEventsPath(paths, jobId), "Event sequences are not unique and increasing.");
      events = await readEventLog(jobEventsPath(paths, jobId), { ...options, includeIncomplete: false });
    }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      events = await readArchivedEvents(paths.archivesDir, job?.eventArchive, options);
    }
    const terminalEvent = job?.terminalEvent;
    const afterSeq = Number(options.afterSeq || 0);
    if (!terminalEvent || Number(terminalEvent.seq) <= afterSeq) return events;

    // A stop between state publication and the event append remains replayable.
    // Archives can also contain only the prefix preceding that interrupted append.
    const committed = job.eventArchive ? events : await readEventLog(jobEventsPath(paths, jobId), {
      afterSeq: Number(terminalEvent.seq) - 1,
      limit: 1,
      includeIncomplete: false
    }).catch((error) => error.code === "ENOENT" ? [] : Promise.reject(error));
    if (committed.some((event) => Number(event.seq) === Number(terminalEvent.seq))) return events;
    return [...events, terminalEvent]
      .sort((left, right) => Number(left.seq) - Number(right.seq))
      .slice(0, options.limit === undefined ? 500 : Math.max(0, Math.trunc(Number(options.limit) || 0)));
  });
}

export async function writeJobState(paths, job) {
  return withFileLock(jobPath(paths, job.id), () => writeJobStateLocked(paths, job));
}

async function writeJobStateLocked(paths, job) {
  await ensureWorkerStateDir(paths);
  const existing = await readJobStateUnlocked(paths, job.id);
  if (existing?.eventArchive && job.acceptedAt && job.acceptedAt !== existing.acceptedAt) {
    throw new Error("Archived worker jobs are immutable; use a new job ID.");
  }
  const next = {
    version: STATE_VERSION,
    ...(existing ?? {}),
    ...job,
    lastSeq: job.lastSeq ?? existing?.lastSeq,
    updatedAt: job.updatedAt || new Date().toISOString()
  };
  if (terminalStatusFromJob(next.status) && !validTimestamp(next.completedAt)) {
    next.completedAt = new Date().toISOString();
  }
  await writeJsonFileAtomic(jobPath(paths, job.id), next);
}

export async function readJobState(paths, jobId) {
  return withFileLock(jobPath(paths, jobId), () => readJobStateUnlocked(paths, jobId));
}

async function readJobStateUnlocked(paths, jobId) {
  const file = jobPath(paths, jobId);
  let job;
  try {
    job = await readJsonFileSafe(file, MISSING);
    if (job === MISSING) return null;
    if (!job || Array.isArray(job) || job.id !== jobId) {
      throw stateError(file, "Invalid worker job state.");
    }
  } catch (error) {
    if (error.code === "EWORKERSTATE") await quarantineCorruptFile(file, paths.corruptDir);
    throw error;
  }
  if (!job || job.eventArchive) return job;
  const ledger = await inspectJobEvents(paths, jobId);
  if (!ledger.monotonic) throw stateError(jobEventsPath(paths, jobId), "Event sequences are not unique and increasing.");
  const pendingTerminal = terminalStatusFromEvent(job.terminalEvent) === job.status
    && Number(job.lastSeq) === Number(job.terminalEvent?.seq)
    && Number(job.lastSeq) === ledger.lastSeq + 1
    && job.completedAt === job.terminalEvent?.completedAt
    && validTimestamp(job.completedAt);
  if (Number(job.lastSeq || 0) > ledger.lastSeq && !pendingTerminal) {
    throw stateError(jobEventsPath(paths, jobId), "Event log is behind the persisted cursor; explicit recovery is required.");
  }
  const recovered = { ...job, lastSeq: pendingTerminal ? Number(job.lastSeq) : ledger.lastSeq };
  if (ledger.lastSeq > Number(job.lastSeq || 0)) {
    recovered.status = ledger.lastEvent?.status || statusFromEvent(ledger.lastEvent?.type) || job.status;
    recovered.updatedAt = ledger.lastEvent?.at || job.updatedAt;
  }
  return recovered;
}

async function inspectJobEvents(paths, jobId) {
  try { return await readEventLog.inspect(jobEventsPath(paths, jobId)); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { lastSeq: 0, completeBytes: 0, size: 0, monotonic: true };
  }
}

export async function readActiveJobs(paths) {
  return withFileLock(paths.activeJobs, () => readActiveJobsLocked(paths));
}

async function readActiveJobsLocked(paths, { rebuild = false } = {}) {
  let corrupt = false;
  let previous;
  try {
    const payload = await readJsonFileSafe(paths.activeJobs, MISSING);
    if (payload !== MISSING) {
      if (!payload || Array.isArray(payload.jobs) || !payload.jobs || typeof payload.jobs !== "object") {
        throw stateError(paths.activeJobs, "Invalid active worker index.");
      }
      for (const [id, job] of Object.entries(payload.jobs)) {
        if (!job || job.id !== id || !job.chatKey || typeof job.status !== "string") {
          throw stateError(paths.activeJobs, "Invalid active worker entry.");
        }
      }
      if (!rebuild) return payload;
      previous = payload;
    }
  } catch (error) {
    if (error.code !== "EWORKERSTATE") throw error;
    corrupt = true;
  }
  // ENOENT can also mean an interrupted recovery. Rebuild before admitting work.
  const payload = previous || defaultActiveJobs();
  let files;
  try { files = await fs.readdir(paths.jobsDir); }
  catch (error) { if (error.code !== "ENOENT") throw error; files = []; }
  for (const name of files.filter((name) => name.endsWith(".json"))) {
    const id = name.slice(0, -5);
    const job = await readJobState(paths, id);
    if (!job) throw stateError(path.join(paths.jobsDir, name), "Job disappeared during recovery.");
    if (!job.chatKey || typeof job.status !== "string") {
      throw stateError(path.join(paths.jobsDir, name), "Cannot reconstruct active worker entry.");
    }
    if (!["completed", "failed", "cancelled"].includes(job.status)) payload.jobs[id] = job;
    else delete payload.jobs[id];
  }
  if (corrupt) await quarantineCorruptFile(paths.activeJobs, paths.corruptDir);
  await writeJsonFileAtomic(paths.activeJobs, payload);
  return payload;
}

export async function upsertActiveJob(paths, job) {
  return withFileLock(paths.activeJobs, async () => {
    const payload = await readActiveJobsLocked(paths);
    payload.jobs[job.id] = {
      ...payload.jobs[job.id],
      ...job,
      updatedAt: new Date().toISOString()
    };
    payload.updatedAt = new Date().toISOString();
    await writeJsonFileAtomic(paths.activeJobs, payload);
    return payload.jobs[job.id];
  });
}

export async function removeActiveJob(paths, jobId) {
  await withFileLock(paths.activeJobs, async () => {
    const payload = await readActiveJobsLocked(paths);
    delete payload.jobs[jobId];
    payload.updatedAt = new Date().toISOString();
    await writeJsonFileAtomic(paths.activeJobs, payload);
  });
}

function jobPath(paths, jobId) {
  return path.join(paths.jobsDir, `${safeName(jobId)}.json`);
}

function jobEventsPath(paths, jobId) {
  return path.join(paths.eventsDir, `${safeName(jobId)}.jsonl`);
}

function defaultActiveJobs() {
  return { version: STATE_VERSION, updatedAt: "", jobs: {} };
}

function statusFromEvent(type) {
  if (type === "worker.job.completed") return "completed";
  if (type === "worker.job.failed") return "failed";
  if (type === "worker.job.cancelled") return "cancelled";
  if (type === "worker.job.started") return "running";
  if (type === "worker.job.accepted") return "accepted";
  return "";
}

function terminalStatusFromEvent(event) {
  if (event?.type === "worker.job.completed") return "completed";
  if (event?.type === "worker.job.failed") return "failed";
  if (event?.type === "worker.job.cancelled") return "cancelled";
  return "";
}

function terminalStatusFromJob(status) {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function validTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function safeName(value) {
  return String(value || "unknown").replace(/[^a-zA-Z0-9._:-]/g, "_").slice(0, 120);
}

async function readJsonFileSafe(filePath, fallback) {
  let text;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
  try { return JSON.parse(text); }
  catch (cause) { throw stateError(filePath, "Invalid worker JSON.", cause); }
}

function stateError(filePath, message, cause) {
  const error = new Error(`${message} (${filePath})`, { cause });
  error.code = "EWORKERSTATE";
  return error;
}

async function writeJsonFileAtomic(filePath, payload) {
  await writePrivateFileAtomic(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

async function withFileLock(filePath, fn) {
  const previous = fileLocks.get(filePath) ?? Promise.resolve();
  let releaseCurrent;
  const current = new Promise((resolve) => {
    releaseCurrent = resolve;
  });
  const queued = previous.catch(() => {}).then(() => current);
  fileLocks.set(filePath, queued);
  await previous.catch(() => {});
  try {
    return await fn();
  } finally {
    releaseCurrent();
    if (fileLocks.get(filePath) === queued) fileLocks.delete(filePath);
  }
}

async function quarantineCorruptFile(filePath, quarantineDir) {
  await ensurePrivateDirectory(quarantineDir);
  const target = path.join(quarantineDir, `${path.basename(filePath)}.${randomUUID()}.corrupt`);
  const temporary = `${target}.tmp`;
  // Keep the original until recovery succeeds; failed quarantine must block writes.
  try {
    await fs.copyFile(filePath, temporary, fs.constants.COPYFILE_EXCL);
    await hardenPrivateTree(temporary);
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
