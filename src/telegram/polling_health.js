import path from "node:path";
import { writePrivateFileAtomic } from "../fs/private.js";
import { createPollingGuard } from "./polling_guard.js";

// Observe and guard the existing consumer; never create a second getUpdates loop.
export function observeTelegramPolling(bot, config = {}, { now = Date.now, pid = process.pid, logger = console } = {}) {
  if (!bot.telegram?.callApi) return { stop: async () => {}, close: () => {} };
  const original = bot.telegram.callApi;
  const guard = createPollingGuard(original, { now, logger });
  const file = config.codexUpdateDir && path.join(config.codexUpdateDir, "telegram-polling-health.json");
  let stopping = false;
  let writes = Promise.resolve();
  const persist = () => {
    if (!file) return writes;
    const value = { pid, at: now(), stopping, polling: guard.snapshot() };
    writes = writes.then(() => writePrivateFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`))
      .catch((error) => logger.warn("Telegram polling health write failed:", error.code || "unknown"));
    return writes;
  };
  const wrapped = async function (...args) {
    try { return await guard.callApi.apply(this, args); }
    finally { if (args[0] === "getUpdates") await persist(); }
  };
  bot.telegram.callApi = wrapped;
  void persist();
  const timer = setInterval(persist, 5000);
  timer.unref();
  return {
    stop: async () => { stopping = true; guard.stop(); clearInterval(timer); await persist(); },
    close: () => { guard.stop(); clearInterval(timer); if (bot.telegram.callApi === wrapped) bot.telegram.callApi = original; }
  };
}
