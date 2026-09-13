import fs from "node:fs/promises";
import { constants, createReadStream, createWriteStream } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip, createGunzip } from "node:zlib";
import { ensurePrivateDirectory } from "../fs/private.js";
import { normalizeWorkerDeliveryEntry } from "./delivery.js";

export function deliveryReceipt(job, entry) {
  if (
    !job?.id ||
    !job.acceptedAt ||
    !job.completedAt ||
    job.status !== "completed" ||
    entry?.deliveryStatus !== "delivery_sent" ||
    entry.ambiguous === true ||
    entry.jobId !== job.id ||
    entry.chatKey !== job.chatKey ||
    !Number.isFinite(Date.parse(entry.sentAt)) ||
    !(
      Date.parse(job.acceptedAt) <= Date.parse(job.completedAt) &&
      Date.parse(job.completedAt) <= Date.parse(entry.sentAt)
    ) ||
    !(job.lastSeq > 0) ||
    entry.seq < job.lastSeq
  )
    return null;
  return {
    acceptedAt: job.acceptedAt,
    chatKey: job.chatKey,
    seq: job.lastSeq,
    sentAt: entry.sentAt,
  };
}

function receiptMatches(job) {
  const receipt = job?.deliveryReceipt;
  return (
    receipt?.acceptedAt === job.acceptedAt &&
    receipt?.chatKey === job.chatKey &&
    receipt?.seq === job.lastSeq &&
    Number.isFinite(Date.parse(receipt?.sentAt))
  );
}

async function json(file, optional = false) {
  if (!file)
    throw new Error("Worker archival requires configured bot state paths.");
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (optional && error.code === "ENOENT") return {};
    throw error;
  }
}
function object(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

// Refuse cleanup if any protection source is unreadable/malformed. Missing
// optional recovery files mean no snapshot/marker has been written yet.
async function protections(config, store) {
  const [state, active, snapshots, marker] = await Promise.all([
    json(config.stateFile),
    json(store.paths.activeJobs, true),
    json(path.join(config.botRecoveryDir, "active-turns.json"), true),
    json(path.join(config.botRecoveryDir, "restart-marker.json"), true),
  ]);
  if (
    ![state, active, snapshots, marker].every(object) ||
    (state.worker !== undefined && !object(state.worker)) ||
    (state.worker?.deliveries !== undefined && !object(state.worker.deliveries))
  ) {
    throw new Error("Malformed worker archival protection state.");
  }
  for (const [value, key] of [
    [state, "schemaVersion"],
    [active, "version"],
    [snapshots, "version"],
    [marker, "version"],
  ]) {
    if (
      value[key] !== undefined &&
      (!Number.isInteger(value[key]) || value[key] < 0 || value[key] > 1)
    ) {
      throw new Error("Unsupported worker archival protection schema.");
    }
  }
  if (
    (state.queues !== undefined &&
      (!object(state.queues) ||
        !Object.values(state.queues).every(Array.isArray))) ||
    (snapshots.turns !== undefined &&
      (!object(snapshots.turns) ||
        !Object.values(snapshots.turns).every(object))) ||
    (marker.recoveries !== undefined &&
      (!Array.isArray(marker.recoveries) || !marker.recoveries.every(object)))
  ) {
    throw new Error("Malformed worker recovery protection state.");
  }
  const ids = new Set();
  // Include references in queued recoveries and restart candidates, even across
  // schema additions. Do not interpret prompts or message contents as metadata.
  const collect = (value) => {
    if (!value || typeof value !== "object") return;
    if (typeof value.workerJobId === "string") ids.add(value.workerJobId);
    for (const child of Object.values(value))
      if (child && typeof child === "object") collect(child);
  };
  if (active.jobs !== undefined && !object(active.jobs))
    throw new Error("Malformed active job index.");
  for (const id of Object.keys(active.jobs || {})) ids.add(id);
  collect(snapshots);
  collect(marker);
  collect(state.queues);
  const sent = new Map();
  for (const [key, raw] of Object.entries(state.worker?.deliveries || {})) {
    const entry = normalizeWorkerDeliveryEntry(key, raw);
    if (!entry) throw new Error("Malformed worker delivery ledger.");
    if (entry.deliveryStatus === "delivery_sent" && !entry.ambiguous)
      sent.set(entry.jobId, entry);
    else ids.add(entry.jobId);
  }
  return { ids, sent };
}

export function createWorkerLogMaintenance({ config, store, now = Date.now }) {
  let running = null;
  async function run({
    apply = false,
    retentionDays = config.codexWorkerLogRetentionDays || 30,
    maxFiles = 20,
  } = {}) {
    if (typeof apply !== "boolean") throw new Error("Apply must be a boolean.");
    if (!Number.isFinite(retentionDays) || retentionDays < 1)
      throw new Error("Retention must be at least one day.");
    if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 100)
      throw new Error("Archive batch size must be 1–100 files.");
    const guard = await protections(config, store);
    const report = {
      scanned: 0,
      eligible: 0,
      archived: 0,
      protected: 0,
      originalBytes: 0,
      compressedBytes: 0,
    };
    const files = await fs.readdir(store.paths.eventsDir, {
      withFileTypes: true,
    });
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
      const id = file.name.slice(0, -6);
      report.scanned += 1;
      await store.withJobLock(id, async () => {
        const job = await store.readJobState(id);
        const receipt = deliveryReceipt(job, guard.sent.get(id));
        if (receipt && apply && !receiptMatches(job))
          await store.writeJobStateLocked({ id, deliveryReceipt: receipt });
        const confirmed = receipt ? { ...job, deliveryReceipt: receipt } : job;
        const completedAt = Date.parse(job?.completedAt);
        const sentAt = Date.parse(confirmed?.deliveryReceipt?.sentAt);
        if (
          !job ||
          job.id !== id ||
          job.status !== "completed" ||
          !receiptMatches(confirmed) ||
          guard.ids.has(id) ||
          !Number.isFinite(completedAt) ||
          Math.max(completedAt, sentAt) > now() - retentionDays * 86_400_000
        ) {
          report.protected += 1;
          return;
        }
        report.eligible += 1;
        if (!apply || report.archived >= Math.max(1, Math.min(100, maxFiles)))
          return;
        const source = path.join(store.paths.eventsDir, file.name);
        const archived = await archive(
          source,
          store.paths.archivesDir,
          async () => {
            const latest = await protections(config, store);
            return !latest.ids.has(id);
          },
          async (metadata) =>
            store.writeJobStateLocked({ id, eventArchive: metadata }),
        );
        if (archived) {
          report.archived += 1;
          report.originalBytes += archived.bytes;
          report.compressedBytes += archived.compressedBytes;
        }
      });
    }
    return report;
  }
  return {
    run(options) {
      // A preview must never accidentally join a mutating invocation.
      if (running)
        return Promise.reject(
          new Error("Worker log maintenance is already running."),
        );
      running = run(options).finally(() => {
        running = null;
      });
      return running;
    },
  };
}

async function archive(source, directory, stillSafe, recordArchive) {
  await ensurePrivateDirectory(directory);
  const temporary = path.join(directory, `.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(
      source,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) return null;
    const hash = createHash("sha256");
    const digest = new Transform({
      transform(chunk, _encoding, callback) {
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(
      handle.createReadStream({ autoClose: false }),
      digest,
      createGzip(),
      createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
    );
    const sha256 = hash.digest("hex");
    const check = createHash("sha256");
    let bytes = 0;
    await pipeline(
      createReadStream(temporary),
      createGunzip(),
      async (chunks) => {
        for await (const chunk of chunks) {
          check.update(chunk);
          bytes += chunk.length;
        }
      },
    );
    if (check.digest("hex") !== sha256 || bytes !== Number(before.size))
      throw new Error("Worker archive verification failed.");
    const metadata = {
      file: `${path.basename(source)}.${sha256}.gz`,
      sha256,
      bytes,
      compressedBytes: (await fs.stat(temporary)).size,
      archivedAt: new Date().toISOString(),
    };
    const target = path.join(directory, metadata.file);
    // Atomic publication. A retry preserves an existing verified archive.
    try {
      await fs.link(temporary, target);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      // Never remove the source on the strength of a pre-existing archive alone.
      const existingHash = createHash("sha256");
      await pipeline(
        createReadStream(target),
        createGunzip(),
        async (chunks) => {
          for await (const chunk of chunks) existingHash.update(chunk);
        },
      );
      if (existingHash.digest("hex") !== sha256)
        throw new Error("Existing worker archive differs.");
    }
    await recordArchive(metadata);
    const after = await fs.lstat(source, { bigint: true });
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs ||
      !(await stillSafe())
    )
      return null;
    await fs.unlink(source);
    return metadata;
  } finally {
    await handle?.close();
    await fs.rm(temporary, { force: true });
  }
}

export async function readArchivedEvents(
  directory,
  metadata,
  { afterSeq = 0, limit = 500 } = {},
) {
  if (
    !metadata ||
    path.basename(metadata.file || "") !== metadata.file ||
    !/^[\w.:-]+\.gz$/.test(metadata.file)
  )
    return [];
  const hash = createHash("sha256");
  const events = [];
  let pending = Buffer.alloc(0);
  const consume = (line) => {
    if (!line.length) return;
    const event = JSON.parse(line.toString("utf8"));
    if (Number(event.seq || 0) > Number(afterSeq || 0) && events.length < limit)
      events.push(event);
  };
  await pipeline(
    createReadStream(path.join(directory, metadata.file)),
    createGunzip(),
    async (chunks) => {
      for await (const chunk of chunks) {
        hash.update(chunk);
        const body = pending.length ? Buffer.concat([pending, chunk]) : chunk;
        let start = 0;
        for (let i = 0; i < body.length; i += 1)
          if (body[i] === 10) {
            consume(body.subarray(start, i));
            start = i + 1;
          }
        pending = Buffer.from(body.subarray(start));
      }
    },
  );
  if (hash.digest("hex") !== metadata.sha256)
    throw new Error("Worker archive digest mismatch.");
  if (pending.length) {
    try {
      consume(pending);
    } catch {
      /* same incomplete-tail rule as live logs */
    }
  }
  return events;
}
