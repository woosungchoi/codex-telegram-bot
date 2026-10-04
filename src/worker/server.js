import { createQuestionBroker } from "./questions.js";
import fs from "node:fs/promises";
import net from "node:net";
import { createHash } from "node:crypto";
import { PRIVATE_FILE_MODE } from "../fs/private.js";
import { createFrameReader, encodeFrame, errorResponse, okResponse } from "./protocol.js";
import { createWorkerStore } from "./store.js";
import { createWorkerLogMaintenance } from "./log_retention.js";
import { runWorkerJob } from "./executor.js";
import { updateAdmissionPaused } from "../maintenance/update_state.js";
import {
  WORKER_RESTART_FAILURE_MESSAGE,
  WORKER_RESTART_FAILURE_REASON
} from "./replay.js";

export function createWorkerServer({
  config,
  store = createWorkerStore(config),
  executeJob = runWorkerJob,
  logger = console,
  heartbeatMs = 30_000
} = {}) {
  if (!config) throw new Error("config is required.");
  const controllers = new Map();
  const questions = createQuestionBroker({ store, controllers });
  const chatReservations = new Map();
  const codexClients = new Map();
  const jobTasks = new Map();
  let admissionError;
  const maintenance = createWorkerLogMaintenance({ config, store });
  let maintenanceTimer;
  let maintenanceStart;
  let maintenanceTask;
  const archiveLogs = () => {
    maintenanceTask = maintenance.run({ apply: true }).catch((error) => {
      logger.warn?.("worker log archival skipped:", error instanceof Error ? error.message : String(error));
    });
  };

  async function dispatch(request) {
    const method = request?.method || "";
    const params = request?.params || {};
    if (method === "question/ask") {
      const controller = controllers.get(params.jobId);
      const job = await store.readJobState(params.jobId);
      if (!controller || !job) throw new Error("Question job is not running");
      try { return await questions.ask(job, { id: request.id, params: { isBlocking: true, questions: params.questions, threadId: job.threadId, turnId: job.id } }, controller.signal); }
      catch (error) { controller.abort(error); throw error; }
    }
    if (method === "question/current") return questions.current(params.chatKey);
    if (method === "question/answer") return questions.answer(params);
    if (method === "worker/archive") return maintenance.run(params);
    if (method === "job/delivered") return store.confirmDelivery(params.entry);
    if (method === "worker/status") {
      if (admissionError) throw admissionError;
      return workerStatus(store, controllers);
    }
    if (method === "job/status") return jobStatus(store, params.jobId);
    if (method === "job/events") return jobEvents(store, params.jobId, params);
    if (method === "job/cancel") return cancelJob(store, controllers, params.jobId);
    if (method === "job/start") {
      if (admissionError) throw admissionError;
      if (updateAdmissionPaused(config)) throw new Error("Codex update is waiting for idle; new jobs are paused.");
      return store.withAdmissionLock(() => {
        if (admissionError) throw admissionError;
        return startJob({ config, store, controllers, chatReservations, codexClients, jobTasks, executeJob, logger, heartbeatMs, questions, job: params.job, onAdmissionFailure: (error) => { admissionError = error; } });
      });
    }
    throw new Error(`Unknown worker method: ${method}`);
  }

  const server = net.createServer((socket) => {
    socket.on("error", (error) => {
      if (error?.code === "ECONNRESET" || error?.code === "EPIPE") return;
      logger.warn?.("worker client socket failed:", error instanceof Error ? error.message : String(error));
    });
    const writeResponse = (response) => {
      if (!socket.destroyed && socket.writable) socket.write(encodeFrame(response));
    };
    createFrameReader(socket, async (request) => {
      const id = request?.id || null;
      try {
        const result = await dispatch(request);
        writeResponse(okResponse(id, result));
      } catch (error) {
        writeResponse(errorResponse(id, error));
      }
    }, {
      onError: (error) => {
        writeResponse(errorResponse(null, error));
      }
    });
  });

  return {
    server,
    async listen() {
      await store.ensure();
      await store.recoverActiveJobs();
      await reconcileOrphanedJobs(store);
      await fs.rm(config.codexWorkerSocket, { force: true }).catch(() => {});
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.codexWorkerSocket, () => {
          server.off("error", reject);
          resolve();
        });
      });
      await fs.chmod(config.codexWorkerSocket, PRIVATE_FILE_MODE);
      if (config.codexWorkerLogRetentionDays > 0) {
        maintenanceStart = setTimeout(archiveLogs, 60_000);
        maintenanceTimer = setInterval(archiveLogs, 3_600_000);
        maintenanceStart.unref(); maintenanceTimer.unref();
      }
      return this;
    },
    async close() {
      clearTimeout(maintenanceStart);
      clearInterval(maintenanceTimer);
      await maintenanceTask;
      await new Promise((resolve) => server.close(resolve));
      for (const [jobId, controller] of controllers.entries()) {
        await store.appendJobEvent(jobId, {
          type: "worker.shutdown",
          status: "running",
          message: "worker shutdown"
        }).catch((error) => logger.warn?.("worker shutdown event failed:", error instanceof Error ? error.message : String(error)));
        controller.abort(new Error("worker shutdown"));
      }
      await Promise.allSettled([...jobTasks.values()]);
      await fs.rm(config.codexWorkerSocket, { force: true }).catch(() => {});
    }
  };
}

async function startJob({ config, store, controllers, chatReservations, codexClients, jobTasks, executeJob, logger, heartbeatMs, questions, job, onAdmissionFailure }) {
  if (!job?.id) throw new Error("job/start requires job.id.");
  if (typeof job.id !== "string" || !/^[a-zA-Z0-9._:-]{1,120}$/.test(job.id)) throw new Error("job/start requires a safe job ID of at most 120 characters.");
  if (!job.chatKey) throw new Error("job/start requires job.chatKey.");
  const active = await store.readActiveJobs();
  const requestHash = createHash("sha256").update(JSON.stringify(canonicalJob({ ...job, transport: job.transport || config.codexTransport }))).digest("hex");
  const existing = await store.readJobState(job.id);
  if (existing?.eventArchive) throw new Error("Archived worker jobs are immutable; use a new job ID.");
  if (existing) {
    if (existing.requestHash !== requestHash) throw new Error("Worker job ID already exists with a different request; use a new job ID.");
    return { jobId: job.id, status: existing.status };
  }
  if ((await store.readJobEvents(job.id, { limit: 1 })).length) throw new Error("Worker events already exist without job state; use a new job ID after recovery.");
  if (chatReservations.has(job.chatKey)) throw new Error(`Active worker job already exists for chat ${job.chatKey}: ${chatReservations.get(job.chatKey)}`);
  const duplicate = Object.values(active.jobs).find((entry) => (
    entry?.chatKey === job.chatKey && entry?.status !== "completed" && entry?.status !== "failed" && entry?.status !== "cancelled"
  ));
  if (duplicate) throw new Error(`Active worker job already exists for chat ${job.chatKey}: ${duplicate.id}`);

  const accepted = {
    ...job,
    status: "accepted",
    transport: job.transport || config.codexTransport,
    acceptedAt: new Date().toISOString(),
    lastSeq: 0,
    requestHash
  };
  try {
    await store.writeJobState(accepted);
    await store.upsertActiveJob(accepted);
    await store.appendJobEvent(job.id, {
      type: "worker.job.accepted",
      status: "accepted",
      chatKey: job.chatKey,
      kind: job.kind || "user",
      transport: accepted.transport
    });
  } catch (error) {
    // Never execute after an incomplete admission. A failed tombstone also makes
    // the same ID retry idempotent. If rollback fails, the durable reservation
    // remains conservative and startup reconciliation finishes recovery.
    try {
      await store.writeJobState({ ...accepted, lastSeq: undefined, status: "failed", failureReason: "worker_admission", completedAt: new Date().toISOString() });
      await store.removeActiveJob(job.id);
    } catch (rollbackError) {
      logger.warn?.("worker admission rollback failed:", rollbackError instanceof Error ? rollbackError.message : String(rollbackError));
      const failure = new AggregateError([error, rollbackError], "Worker admission and rollback failed; recovery is required.");
      onAdmissionFailure(failure);
      throw failure;
    }
    throw error;
  }

  const controller = new AbortController();
  controllers.set(job.id, controller);
  chatReservations.set(job.chatKey, job.id);
  const heartbeat = heartbeatMs > 0
    ? setInterval(() => {
      store.appendJobEvent(job.id, {
        type: "worker.heartbeat",
        status: "running",
        chatKey: job.chatKey,
        threadId: job.threadId || "",
        transport: accepted.transport
      }).catch((error) => {
        logger.warn?.("worker heartbeat failed:", error instanceof Error ? error.message : String(error));
      });
    }, heartbeatMs)
    : null;
  heartbeat?.unref?.();
  const stopHeartbeat = () => {
    if (heartbeat) clearInterval(heartbeat);
  };
  controller.signal.addEventListener("abort", stopHeartbeat, { once: true });
  const task = Promise.resolve().then(() => executeJob({ job: accepted, config, store, signal: controller.signal, codexClients, onUserInput: (request, requestSignal) => questions.ask(accepted, request, requestSignal ? globalThis.AbortSignal.any([controller.signal, requestSignal]) : controller.signal) }))
    .catch((error) => {
      logger.warn?.("worker job failed:", error instanceof Error ? error.message : String(error));
    })
    .finally(async () => {
      controller.signal.removeEventListener("abort", stopHeartbeat);
      stopHeartbeat();
      controllers.delete(job.id);
      if (chatReservations.get(job.chatKey) === job.id) chatReservations.delete(job.chatKey);
      await store.removeActiveJob(job.id).catch((error) => logger.warn?.("worker active job cleanup failed:", error instanceof Error ? error.message : String(error)));
    });
  jobTasks.set(job.id, task);
  task.finally(() => {
    if (jobTasks.get(job.id) === task) jobTasks.delete(job.id);
  }).catch(() => {});

  return { jobId: job.id, status: "accepted" };
}

function canonicalJob(value) {
  if (Array.isArray(value)) return value.map(canonicalJob);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJob(value[key])]));
  }
  return value;
}

async function reconcileOrphanedJobs(store) {
  const active = await store.readActiveJobs();
  for (const [indexId, entry] of Object.entries(active.jobs)) {
    const jobId = String(entry?.id || indexId);
    const job = await store.readJobState(jobId);
    if (!isTerminalWorkerStatus(job?.status)) {
      const completedAt = new Date().toISOString();
      await store.writeJobState({
        ...(entry ?? {}),
        ...(job ?? {}),
        id: jobId,
        status: "failed",
        failureReason: job?.userQuestion ? "question_interrupted" : WORKER_RESTART_FAILURE_REASON,
        error: job?.userQuestion ? "Pending decision interrupted by worker restart; explicit recovery required." : WORKER_RESTART_FAILURE_MESSAGE,
        completedAt
      });
      await store.appendJobEvent(jobId, {
        type: "worker.job.failed",
        status: "failed",
        chatKey: job?.chatKey ?? entry?.chatKey,
        threadId: job?.threadId ?? entry?.threadId ?? "",
        reason: job?.userQuestion ? "question_interrupted" : WORKER_RESTART_FAILURE_REASON,
        message: job?.userQuestion ? "Pending decision interrupted by worker restart; explicit recovery required." : WORKER_RESTART_FAILURE_MESSAGE,
        at: completedAt
      });
    }
    await store.removeActiveJob(indexId);
  }
}

async function workerStatus(store, controllers) {
  const active = await store.readActiveJobs();
  return {
    status: "ok",
    capabilities: ["accounts-v1", "log-archive-v1", "questions-v1"],
    activeJobs: Object.values(active.jobs),
    runningJobIds: [...controllers.keys()]
  };
}

async function jobStatus(store, jobId) {
  if (!jobId) throw new Error("job/status requires jobId.");
  const job = await store.readJobState(jobId);
  return { job };
}

async function jobEvents(store, jobId, params) {
  if (!jobId) throw new Error("job/events requires jobId.");
  const events = await store.readJobEvents(jobId, {
    afterSeq: params.afterSeq || 0,
    limit: params.limit || 500
  });
  return { events };
}

async function cancelJob(store, controllers, jobId) {
  if (!jobId) throw new Error("job/cancel requires jobId.");
  const controller = controllers.get(jobId);
  if (!controller) {
    const job = await store.readJobState(jobId);
    if (!job) return { jobId, cancelled: false };
    if (!isTerminalWorkerStatus(job.status)) {
      await store.appendJobEvent(jobId, {
        type: "worker.job.cancelled",
        status: "cancelled",
        chatKey: job.chatKey,
        threadId: job.threadId || "",
        message: "orphaned worker job cancelled"
      });
    }
    await store.removeActiveJob(jobId);
    return { jobId, cancelled: true, orphaned: true };
  }
  await store.appendJobEvent(jobId, {
    type: "worker.job.cancel.requested",
    status: "running",
    message: "cancel requested"
  });
  controller.abort(new Error("cancelled by Telegram bot"));
  return { jobId, cancelled: true };
}

function isTerminalWorkerStatus(status) {
  return status === "completed" || status === "failed" || status === "cancelled";
}
