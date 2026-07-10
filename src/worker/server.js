import fs from "node:fs/promises";
import net from "node:net";
import { PRIVATE_FILE_MODE } from "../fs/private.js";
import { createFrameReader, encodeFrame, errorResponse, okResponse } from "./protocol.js";
import { createWorkerStore } from "./store.js";
import { runWorkerJob } from "./executor.js";

export function createWorkerServer({
  config,
  store = createWorkerStore(config),
  executeJob = runWorkerJob,
  logger = console,
  heartbeatMs = 30_000
} = {}) {
  if (!config) throw new Error("config is required.");
  const controllers = new Map();
  const codexClients = new Map();
  const jobTasks = new Map();

  async function dispatch(request) {
    const method = request?.method || "";
    const params = request?.params || {};
    if (method === "worker/status") return workerStatus(store, controllers);
    if (method === "job/status") return jobStatus(store, params.jobId);
    if (method === "job/events") return jobEvents(store, params.jobId, params);
    if (method === "job/cancel") return cancelJob(store, controllers, params.jobId);
    if (method === "job/start") {
      return startJob({ config, store, controllers, codexClients, jobTasks, executeJob, logger, heartbeatMs, job: params.job });
    }
    throw new Error(`Unknown worker method: ${method}`);
  }

  const server = net.createServer((socket) => {
    createFrameReader(socket, async (request) => {
      const id = request?.id || null;
      try {
        const result = await dispatch(request);
        socket.write(encodeFrame(okResponse(id, result)));
      } catch (error) {
        socket.write(encodeFrame(errorResponse(id, error)));
      }
    }, {
      onError: (error) => {
        socket.write(encodeFrame(errorResponse(null, error)));
      }
    });
  });

  return {
    server,
    async listen() {
      await store.ensure();
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
      return this;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
      for (const [jobId, controller] of controllers.entries()) {
        await store.appendJobEvent(jobId, {
          type: "worker.shutdown",
          status: "running",
          message: "worker shutdown"
        }).catch(() => {});
        controller.abort(new Error("worker shutdown"));
      }
      await Promise.allSettled([...jobTasks.values()]);
      await fs.rm(config.codexWorkerSocket, { force: true }).catch(() => {});
    }
  };
}

async function startJob({ config, store, controllers, codexClients, jobTasks, executeJob, logger, heartbeatMs, job }) {
  if (!job?.id) throw new Error("job/start requires job.id.");
  if (!job.chatKey) throw new Error("job/start requires job.chatKey.");
  const active = await store.readActiveJobs();
  const duplicate = Object.values(active.jobs).find((entry) => (
    entry?.chatKey === job.chatKey && entry?.status !== "completed" && entry?.status !== "failed" && entry?.status !== "cancelled"
  ));
  if (duplicate) throw new Error(`Active worker job already exists for chat ${job.chatKey}: ${duplicate.id}`);

  const accepted = {
    ...job,
    status: "accepted",
    transport: job.transport || config.codexTransport,
    acceptedAt: new Date().toISOString()
  };
  await store.writeJobState(accepted);
  await store.upsertActiveJob(accepted);
  await store.appendJobEvent(job.id, {
    type: "worker.job.accepted",
    status: "accepted",
    chatKey: job.chatKey,
    kind: job.kind || "user",
    transport: accepted.transport
  });

  const controller = new AbortController();
  controllers.set(job.id, controller);
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
  const task = executeJob({ job: accepted, config, store, signal: controller.signal, codexClients })
    .catch((error) => {
      logger.warn?.("worker job failed:", error instanceof Error ? error.message : String(error));
    })
    .finally(async () => {
      controller.signal.removeEventListener("abort", stopHeartbeat);
      stopHeartbeat();
      controllers.delete(job.id);
      await store.removeActiveJob(job.id).catch(() => {});
    });
  jobTasks.set(job.id, task);
  task.finally(() => {
    if (jobTasks.get(job.id) === task) jobTasks.delete(job.id);
  }).catch(() => {});

  return { jobId: job.id, status: "accepted" };
}

async function reconcileOrphanedJobs(store) {
  const active = await store.readActiveJobs();
  for (const [indexId, entry] of Object.entries(active.jobs)) {
    const jobId = String(entry?.id || indexId);
    const job = await store.readJobState(jobId);
    if (!isTerminalWorkerStatus(job?.status)) {
      await store.appendJobEvent(jobId, {
        type: "worker.job.failed",
        status: "failed",
        chatKey: job?.chatKey ?? entry?.chatKey,
        threadId: job?.threadId ?? entry?.threadId ?? "",
        message: "worker restarted before job completed"
      });
    }
    await store.removeActiveJob(indexId);
  }
}

async function workerStatus(store, controllers) {
  const active = await store.readActiveJobs();
  return {
    status: "ok",
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
