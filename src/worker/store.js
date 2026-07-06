import fs from "node:fs/promises";
import path from "node:path";
import { workerPaths } from "./paths.js";

const STATE_VERSION = 1;

export async function ensureWorkerStateDir(paths) {
  await fs.mkdir(paths.stateDir, { recursive: true });
  await fs.mkdir(paths.jobsDir, { recursive: true });
  await fs.mkdir(paths.eventsDir, { recursive: true });
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
    upsertActiveJob: (job) => upsertActiveJob(paths, job),
    removeActiveJob: (jobId) => removeActiveJob(paths, jobId)
  };
}

export async function appendJobEvent(paths, jobId, event) {
  await ensureWorkerStateDir(paths);
  const job = await readJobState(paths, jobId);
  const seq = Number(job?.lastSeq || 0) + 1;
  const payload = {
    ...event,
    seq,
    at: event.at || new Date().toISOString()
  };
  await fs.appendFile(jobEventsPath(paths, jobId), `${JSON.stringify(payload)}\n`, "utf8");
  await writeJobState(paths, {
    ...(job ?? {}),
    id: jobId,
    lastSeq: seq,
    updatedAt: payload.at,
    status: event.status || job?.status || statusFromEvent(event.type)
  });
  return payload;
}

export async function readJobEvents(paths, jobId, { afterSeq = 0, limit = 500 } = {}) {
  try {
    const body = await fs.readFile(jobEventsPath(paths, jobId), "utf8");
    return body.split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((event) => Number(event.seq || 0) > Number(afterSeq || 0))
      .slice(0, limit);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

export async function writeJobState(paths, job) {
  await ensureWorkerStateDir(paths);
  const existing = await readJobState(paths, job.id);
  await writeJsonFileAtomic(jobPath(paths, job.id), {
    version: STATE_VERSION,
    ...(existing ?? {}),
    ...job,
    lastSeq: job.lastSeq ?? existing?.lastSeq,
    updatedAt: job.updatedAt || new Date().toISOString()
  });
}

export async function readJobState(paths, jobId) {
  return readJsonFileSafe(jobPath(paths, jobId), null, { quarantineDir: paths.corruptDir });
}

export async function readActiveJobs(paths) {
  const payload = await readJsonFileSafe(paths.activeJobs, defaultActiveJobs(), { quarantineDir: paths.corruptDir });
  return payload && typeof payload === "object" && payload.jobs && typeof payload.jobs === "object"
    ? payload
    : defaultActiveJobs();
}

export async function upsertActiveJob(paths, job) {
  const payload = await readActiveJobs(paths);
  payload.jobs[job.id] = {
    ...payload.jobs[job.id],
    ...job,
    updatedAt: new Date().toISOString()
  };
  payload.updatedAt = new Date().toISOString();
  await writeJsonFileAtomic(paths.activeJobs, payload);
  return payload.jobs[job.id];
}

export async function removeActiveJob(paths, jobId) {
  const payload = await readActiveJobs(paths);
  delete payload.jobs[jobId];
  payload.updatedAt = new Date().toISOString();
  await writeJsonFileAtomic(paths.activeJobs, payload);
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

function safeName(value) {
  return String(value || "unknown").replace(/[^a-zA-Z0-9._:-]/g, "_").slice(0, 120);
}

async function readJsonFileSafe(filePath, fallback, { quarantineDir = "" } = {}) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    if (quarantineDir) await quarantineCorruptFile(filePath, quarantineDir).catch(() => {});
    return fallback;
  }
}

async function writeJsonFileAtomic(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, filePath);
}

async function quarantineCorruptFile(filePath, quarantineDir) {
  await fs.mkdir(quarantineDir, { recursive: true });
  const target = path.join(quarantineDir, `${path.basename(filePath)}.${Date.now()}.corrupt`);
  await fs.rename(filePath, target);
}
