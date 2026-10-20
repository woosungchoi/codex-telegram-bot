const RETRYABLE_CODES = new Set([
  "ENOENT", "ECONNREFUSED", "ECONNRESET", "EPIPE", "ENOTCONN", "ETIMEDOUT"
]);
const RETRYABLE_LOCALE_KEYS = new Set([
  "errors.workerRequestTimeout", "errors.workerConnectionClosed"
]);

export const WORKER_READY_TIMEOUT_MS = 300_000;

// systemd Type=simple/exec considers a spawned process started before the
// worker has created its socket. Only retry the read-only status handshake;
// replaying job/start could execute a job twice.
export async function waitForWorkerReady(client, {
  timeoutMs = 30_000,
  pollMs = 250,
  signal,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(pollMs) || pollMs <= 0) {
    throw new Error("Worker readiness timeout and poll interval must be positive.");
  }
  const deadline = now() + timeoutMs;
  signal?.throwIfAborted();
  let onAbort;
  const aborted = new Promise((_resolve, reject) => {
    if (signal) {
      onAbort = () => reject(signal.reason || Object.assign(new Error("Worker readiness cancelled."), { name: "AbortError" }));
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  let lastError;
  const timeoutError = () => {
    const error = new Error(`Worker did not become ready within ${timeoutMs}ms: ${lastError?.message || "no status response"}`, { cause: lastError });
    error.code = "WORKER_NOT_READY";
    return error;
  };
  try {
    while (now() < deadline) {
      let timer;
      try {
        const status = await Promise.race([
          client.status(),
          aborted,
          new Promise((_resolve, reject) => {
            timer = setTimeout(() => reject(timeoutError()), Math.max(1, deadline - now()));
          })
        ]);
        signal?.throwIfAborted();
        if (status?.status !== "ok" || !Array.isArray(status.activeJobs) || !Array.isArray(status.runningJobIds)) {
          throw new Error("Worker readiness handshake returned an invalid response.");
        }
        return status;
      } catch (error) {
        if (!RETRYABLE_CODES.has(error.code) && !RETRYABLE_LOCALE_KEYS.has(error.localeKey)) throw error;
        lastError = error;
      } finally { clearTimeout(timer); }
      const remaining = deadline - now();
      if (remaining > 0) await Promise.race([sleep(Math.min(pollMs, remaining)), aborted]);
    }
    throw timeoutError();
  } finally { if (onAbort) signal.removeEventListener("abort", onAbort); }
}
