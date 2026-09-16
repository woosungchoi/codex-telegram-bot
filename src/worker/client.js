import net from "node:net";
import { createFrameReader, createRequestId, encodeFrame } from "./protocol.js";

export function createWorkerClient(config = {}) {
  const socketPath = config.codexWorkerSocket;
  const timeoutMs = config.codexWorkerConnectTimeoutMs ?? 5000;
  return {
    status: () => request(socketPath, timeoutMs, "worker/status"),
    startJob: (job) => request(socketPath, timeoutMs, "job/start", { job }),
    getJobStatus: (jobId) => request(socketPath, timeoutMs, "job/status", { jobId }),
    readJobEvents: (jobId, afterSeq = 0, limit = 500) => request(socketPath, timeoutMs, "job/events", { jobId, afterSeq, limit }),
    confirmDelivery: (entry) => request(socketPath, timeoutMs, "job/delivered", { entry }),
    archiveLogs: (options = {}) => request(socketPath, Math.max(timeoutMs, 300_000), "worker/archive", options),
    cancelJob: (jobId) => request(socketPath, timeoutMs, "job/cancel", { jobId })
  };
}

function request(socketPath, timeoutMs, method, params = {}) {
  if (!socketPath) return Promise.reject(new Error("CODEX_WORKER_SOCKET is required."));
  const id = createRequestId("worker");
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    let timer = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      socket.destroy();
      fn(value);
    };
    timer = setTimeout(() => {
      finish(reject, new Error(`worker request timed out: ${method}`));
    }, timeoutMs);

    createFrameReader(socket, (response) => {
      if (response?.id !== id) return;
      if (response.ok) finish(resolve, response.result);
      else finish(reject, new Error(response?.error?.message || `worker request failed: ${method}`));
    }, {
      onError: (error) => finish(reject, error)
    });

    socket.on("connect", () => {
      socket.write(encodeFrame({ id, method, params }));
    });
    socket.on("error", (error) => finish(reject, error));
    socket.on("end", () => {
      if (!settled) finish(reject, new Error(`worker connection closed: ${method}`));
    });
  });
}
