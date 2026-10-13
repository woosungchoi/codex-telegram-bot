import { summarizeTelegramError } from "./api.js";

// Telegram normally holds getUpdates for 50 seconds. Bound the HTTP request,
// not a Codex turn or a message handler, and let Telegraf retain its offset.
export function createPollingGuard(original, {
  now = Date.now, logger = console, warnAfterMs = 65_000, timeoutMs = 75_000,
  lagWarnMs = 30_000, setTimer = setTimeout, clearTimer = clearTimeout
} = {}) {
  const stats = {
    lastRequestAt: null, lastSuccessAt: null, lastErrorAt: null, lastError: null,
    consecutiveErrors: 0, totalErrors: 0, timeouts: 0, lastDurationMs: null,
    lastUpdateLagMs: null, maxUpdateLagMs: 0
  };
  const pending = new Set();
  let stopped = false;
  const log = (event, detail = {}, warning = true) => {
    const method = warning ? "warn" : "log";
    logger[method]?.("Telegram polling:", JSON.stringify({ event, at: now(), ...detail }));
  };
  async function callApi(method, payload, options, ...rest) {
    if (method !== "getUpdates" || !(payload?.timeout > 0) || stopped) {
      return original.call(this, method, payload, options, ...rest);
    }
    const startedAt = now();
    stats.lastRequestAt = startedAt;
    const controller = new AbortController();
    const parent = options?.signal;
    const abort = () => controller.abort();
    parent?.addEventListener("abort", abort, { once: true });
    if (parent?.aborted) abort();
    let timedOut = false, warned = false;
    const warning = setTimer(() => {
      if (stopped || parent?.aborted) return;
      warned = true;
      log("telegram_poll_slow", { elapsedMs: now() - startedAt, timeoutMs });
    }, warnAfterMs);
    const deadline = setTimer(() => {
      if (stopped || parent?.aborted) return;
      timedOut = true;
      stats.timeouts += 1;
      log("telegram_poll_timeout", { elapsedMs: now() - startedAt, action: "abort_request" });
      controller.abort();
    }, timeoutMs);
    warning.unref?.();
    deadline.unref?.();
    const cancelTimers = () => {
      clearTimer(warning);
      clearTimer(deadline);
    };
    const cleanup = () => {
      cancelTimers();
      parent?.removeEventListener("abort", abort);
    };
    pending.add(cancelTimers);
    try {
      // Await transport cancellation before Telegraf retries. Promise.race here
      // could leave two getUpdates consumers and lose or duplicate updates.
      const result = await original.call(this, method, payload, { ...options, signal: controller.signal }, ...rest);
      if (stopped || parent?.aborted) return result;
      stats.lastDurationMs = now() - startedAt;
      if (stats.consecutiveErrors || warned) {
        log("telegram_poll_recovered", {
          consecutiveErrors: stats.consecutiveErrors, elapsedMs: stats.lastDurationMs,
          sinceLastSuccessMs: stats.lastSuccessAt == null ? null : now() - stats.lastSuccessAt
        }, false);
      }
      stats.lastSuccessAt = now();
      stats.consecutiveErrors = 0;
      // Only new message timestamps measure delivery lag. Edited messages and
      // callback queries refer to older messages and would create false alarms.
      const dates = (Array.isArray(result) ? result : [])
        .map((update) => update.message?.date ?? update.channel_post?.date)
        .filter((date) => Number.isFinite(date) && date > 0);
      stats.lastUpdateLagMs = dates.length ? Math.max(0, now() - Math.min(...dates) * 1000) : null;
      stats.maxUpdateLagMs = Math.max(stats.maxUpdateLagMs, stats.lastUpdateLagMs || 0);
      if (stats.lastUpdateLagMs >= lagWarnMs) {
        log("telegram_update_delayed", { maxLagMs: stats.lastUpdateLagMs, updateCount: result.length });
      }
      return result;
    } catch (error) {
      if (stopped || parent?.aborted) throw error;
      // Telegraf treats AbortError as shutdown, but FetchError as a retryable
      // transport failure (with its existing five-second retry backoff).
      const failure = timedOut ? Object.assign(new Error("Telegram getUpdates exceeded its request deadline"), {
        name: "FetchError", code: "ETIMEDOUT", type: "request-timeout"
      }) : error;
      stats.lastDurationMs = now() - startedAt;
      stats.lastErrorAt = now();
      stats.lastError = summarizeTelegramError(failure);
      stats.consecutiveErrors += 1;
      stats.totalErrors += 1;
      log("telegram_poll_error", {
        elapsedMs: stats.lastDurationMs, consecutiveErrors: stats.consecutiveErrors,
        error: stats.lastError
      });
      throw failure;
    } finally {
      cleanup();
      pending.delete(cancelTimers);
    }
  }
  return {
    callApi,
    snapshot: () => ({ ...stats }),
    stop() {
      stopped = true;
      // Shutdown cancellation still belongs to Telegraf's parent signal.
      // Leave that listener attached until the pending transport settles.
      for (const cleanup of pending) cleanup();
    }
  };
}
