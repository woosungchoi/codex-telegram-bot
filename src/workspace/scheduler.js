import { authorizeTelegramUpdate } from "../security.js";
import { directory, newId, workspaceState } from "./store.js";
import { nextOccurrence, occurrenceKey } from "./schedule.js";

export const taskChatKey = (id) => `scheduled:${id}`;
const LIVE = new Set(["queued", "running", "delivery_pending"]);

export function createTaskScheduler(r, { accounts, now = Date.now } = {}) {
  const state = workspaceState(r.state);
  let ticking = false;
  const locks = new Set();
  const atCapacity = () => Object.values(state.tasks).filter((task) => locks.has(task.id) || LIVE.has(task.run?.status)).length >= 3;
  function busy(task) {
    const key = taskChatKey(task.id);
    return locks.has(task.id) || r.activeTurns.has(key) || r.getPendingTurns(key).length > 0 || r.hasPendingFinalDelivery(key);
  }
  async function recordResult(key, prepared, result) {
    const task = Object.values(state.tasks).find((t) => taskChatKey(t.id) === key);
    if (!task?.run || !LIVE.has(task.run.status)) return;
    task.run.status = result.delivered ? "completed" : result.cancelled ? "cancelled" : result.deliveryPending ? "delivery_pending" : "failed";
    task.run.finishedAt = now();
    task.run.threadId = result.threadId || r.getChatState(key).threadId || "";
    task.run.lastTurnId = prepared.id;
    await r.saveState();
  }
  async function reconcile(task) {
    if (!task.run || !LIVE.has(task.run.status)) return;
    const key = taskChatKey(task.id);
    const deliveries = Object.values(r.state.worker?.deliveries || {}).filter((d) => d.chatKey === key);
    const previousJobs = new Set((task.history || []).map((run) => run.id));
    if (deliveries.some((d) => d.deliveryStatus === "delivery_sent"
      && (d.jobId === task.run.id || (!previousJobs.has(d.jobId) && Date.parse(d.resultReadyAt || "") >= task.run.startedAt)))) {
      task.run.status = "completed";
      task.run.finishedAt = now();
      await r.saveState();
    } else if (r.activeTurns.has(key)) task.run.status = "running";
    else if (r.hasPendingFinalDelivery(key)) task.run.status = "delivery_pending";
    else if (!busy(task) && now() - task.run.startedAt > 120_000) {
      // A queued run can expire or be cancelled while the bot is offline.
      // Do not replay an ambiguous execution automatically.
      task.run.status = "interrupted";
      task.run.finishedAt = now();
      await r.saveState();
    }
  }
  async function run(task, { manual = false } = {}) {
    if (busy(task) || LIVE.has(task.run?.status)) throw new Error("This scheduled task already has an unfinished run.");
    if (atCapacity()) throw new Error("Three scheduled runs are already pending. Wait for one to finish.");
    if (String(r.bot.botInfo?.id) !== String(task.destination.botId)) throw new Error("The originating Telegram bot does not match.");
    const authorization = authorizeTelegramUpdate({
      from: { id: task.userId }, chat: { id: task.destination.chatId },
      message: { message_thread_id: task.destination.messageThreadId }
    }, r.config);
    if (!authorization.ok) throw new Error("The task owner or destination is no longer authorized.");
    locks.add(task.id);
    try {
      await accounts.get(task.accountId).then((a) => { if (a.status !== "ready") throw new Error("The saved account needs sign-in."); });
      await directory(task.options.workingDirectory);
      const key = taskChatKey(task.id);
      const id = `schedule-${task.id}-${newId()}`;
      const at = now();
      const old = { run: task.run, nextAt: task.nextAt, enabled: task.enabled, history: task.history };
      task.history = [...(task.history || []), ...(task.run ? [task.run] : [])].slice(-10);
      task.run = { id, status: "queued", startedAt: at, manual };
      if (!manual) {
        const local = occurrenceKey(task.nextAt, task.schedule);
        task.nextAt = nextOccurrence(task.schedule, at, local);
        if (task.nextAt == null) task.enabled = false;
      }
      // A separate chat state supplies a fresh session and a frozen account/options
      // snapshot to both the inline executor and the sidecar, including after reboot.
      r.state.chats[key] = { options: { ...task.options }, accountId: task.accountId,
        scheduledTaskId: task.id, destination: task.destination, updatedAt: new Date(at).toISOString() };
      r.threadCache.delete(key);
      const text = `⏰ ${task.name}\n\n${task.prompt}`;
      const prepared = {
        id, kind: "scheduled", accountId: task.accountId, chatKey: key, chatId: task.destination.chatId, chatType: task.destination.chatType,
        messageThreadId: task.destination.messageThreadId, text,
        inputText: r.applyPersonaPrompt(text), imagePaths: [],
        enqueuedAt: new Date(at).toISOString(), expiresAt: new Date(at + 86400_000).toISOString()
      };
      // enqueue saves the receipt and the queue together in the same state file.
      const queued = await r.enqueuePendingTurn(key, prepared);
      if (!queued.ok) { Object.assign(task, old); await r.saveState(); throw new Error("The scheduled task queue is full."); }
      await r.startQueueDrainIfIdle(key, r.createSyntheticCtx(prepared));
      return task.run;
    } finally { locks.delete(task.id); }
  }
  async function tick() {
    if (ticking || !r.bot.botInfo?.id) return;
    ticking = true;
    try {
      for (const task of Object.values(state.tasks)) {
        await reconcile(task);
        if (!task.enabled || !task.nextAt || task.nextAt > now() || busy(task) || LIVE.has(task.run?.status)) continue;
        if (atCapacity()) continue;
        if (r.isQueuePaused(task.destination.chatKey)) continue;
        try { await run(task); } catch (error) {
          task.enabled = false;
          task.error = r.redactText?.(error.message) || error.message;
          await r.saveState();
        }
      }
    } finally { ticking = false; }
  }
  async function stopRun(task) {
    const key = taskChatKey(task.id);
    await r.clearPendingTurns(key);
    const active = r.activeTurns.get(key);
    if (active) {
      active.stopRequested = true;
      active.abortController?.abort();
      if (active.workerJobId) await r.cancelWorkerJobOnce(active, active.workerJobId);
    }
    if (task.run && LIVE.has(task.run.status)) task.run.status = "cancelled";
    await r.saveState();
  }
  return { tick, run, busy, recordResult, reconcile, stopRun };
}
