import {
  dequeueNextTurn,
  enqueueTurn,
  hydratePendingQueues,
  moveTurn,
  pruneExpiredTurns,
  removeRecoveryTurns,
  removeTurn,
  serializePendingTurn
} from "../queue.js";
import { code } from "../telegram/html.js";
import { hasPendingWorkerDelivery } from "../worker/delivery.js";

const VALID_QUEUE_MODES = new Set(["safe", "interrupt", "side"]);

export function createQueueRuntimeController({
  state,
  activeTurns,
  pendingTurns,
  sideTurns,
  settings,
  chats,
  persistence,
  telegram,
  turns,
  logger = console,
  now = () => new Date(),
  random = Math.random,
  timers = { setTimeout }
}) {
  function getPendingTurns(chatKey) {
    return pendingTurns.get(chatKey) ?? [];
  }

  async function enqueuePendingTurn(chatKey, preparedTurn) {
    return enqueuePendingTurnAt(chatKey, preparedTurn, false);
  }

  async function enqueuePendingTurnFront(chatKey, preparedTurn) {
    return enqueuePendingTurnAt(chatKey, preparedTurn, true);
  }

  async function enqueuePendingTurnAt(chatKey, preparedTurn, front) {
    const queue = getPendingTurns(chatKey);
    const result = enqueueTurn(queue, preparedTurn, {
      max: settings.maxPendingTurns(),
      front
    });
    if (!result.ok) return { ok: false, position: queue.length };
    pendingTurns.set(chatKey, result.queue);
    await persistPendingTurns(chatKey);
    return { ok: true, position: result.position };
  }

  async function dequeuePendingTurn(chatKey, ctx = null) {
    const result = dequeueNextTurn(getPendingTurns(chatKey), queueExpiryOptions());
    replaceQueue(chatKey, result.queue);
    await persistPendingTurns(chatKey);
    if (result.expired > 0 && ctx) await telegram.notifyExpired(ctx, result.expired);
    return result.turn;
  }

  async function clearPendingTurns(chatKey) {
    const count = getPendingTurns(chatKey).length;
    pendingTurns.delete(chatKey);
    await persistPendingTurns(chatKey);
    return count;
  }

  async function clearRecoveryPendingTurns() {
    let cleared = 0;
    for (const [chatKey, queue] of [...pendingTurns.entries()]) {
      const result = removeRecoveryTurns(queue);
      if (result.changed === 0) continue;
      cleared += result.changed;
      replaceQueue(chatKey, result.queue);
      await persistPendingTurns(chatKey);
    }
    return cleared;
  }

  async function removePendingTurn(chatKey, selector) {
    const result = removeTurn(getPendingTurns(chatKey), selector);
    if (result.changed === 0) return 0;
    replaceQueue(chatKey, result.queue);
    await persistPendingTurns(chatKey);
    return result.changed;
  }

  async function movePendingTurn(chatKey, turnId, direction) {
    const result = moveTurn(getPendingTurns(chatKey), turnId, direction);
    if (result.changed === 0) return 0;
    pendingTurns.set(chatKey, result.queue);
    await persistPendingTurns(chatKey);
    return result.changed;
  }

  function countPendingTurns() {
    let count = 0;
    for (const queue of pendingTurns.values()) count += queue.length;
    return count;
  }

  function hydratePendingTurnsFromState() {
    const hydrated = hydratePendingQueues(state.queues, {
      ...queueExpiryOptions(),
      createId: createQueueItemId
    });
    pendingTurns.clear();
    for (const [chatKey, queue] of hydrated.pending.entries()) pendingTurns.set(chatKey, queue);
    state.queues = hydrated.queues;
  }

  async function persistPendingTurns(chatKey) {
    const queue = getPendingTurns(chatKey).map(serializePendingTurn);
    if (queue.length > 0) state.queues[chatKey] = queue;
    else delete state.queues[chatKey];
    await persistence.save();
  }

  async function pruneExpiredPendingTurns(chatKey, ctx = null) {
    const result = pruneExpiredTurns(getPendingTurns(chatKey), queueExpiryOptions());
    if (result.expired === 0) return 0;
    replaceQueue(chatKey, result.queue);
    await persistPendingTurns(chatKey);
    if (ctx) await telegram.notifyExpired(ctx, result.expired);
    return result.expired;
  }

  function queueExpiryOptions() {
    return { maxAgeSeconds: settings.maxPendingAgeSeconds() };
  }

  function createQueueItemId() {
    return `${now().getTime().toString(36)}${random().toString(36).slice(2, 8)}`;
  }

  function isQueuePaused(chatKey) {
    return chats.get(chatKey).queuePaused === true;
  }

  function hasPendingFinalDelivery(chatKey) {
    return hasPendingWorkerDelivery(state.worker?.deliveries, chatKey);
  }

  function getQueueMode(chatKey) {
    const mode = chats.get(chatKey).queueMode;
    return VALID_QUEUE_MODES.has(mode) ? mode : "safe";
  }

  async function setQueuePaused(chatKey, paused) {
    const chat = chats.get(chatKey);
    chat.queuePaused = paused;
    chat.updatedAt = now().toISOString();
    await persistence.save();
  }

  async function setQueueMode(chatKey, mode) {
    const chat = chats.get(chatKey);
    chat.queueMode = mode;
    chat.updatedAt = now().toISOString();
    await persistence.save();
  }

  function trackSideTurn(chatKey, abortController) {
    const controllers = sideTurns.get(chatKey) ?? new Set();
    controllers.add(abortController);
    sideTurns.set(chatKey, controllers);
  }

  function untrackSideTurn(chatKey, abortController) {
    const controllers = sideTurns.get(chatKey);
    if (!controllers) return;
    controllers.delete(abortController);
    if (controllers.size === 0) sideTurns.delete(chatKey);
  }

  function stopSideTurns(chatKey) {
    const controllers = sideTurns.get(chatKey);
    if (!controllers) return 0;
    const count = controllers.size;
    for (const controller of controllers) controller.abort();
    return count;
  }

  function getSideTurnCount(chatKey) {
    return sideTurns.get(chatKey)?.size ?? 0;
  }

  function countSideTurns() {
    let count = 0;
    for (const controllers of sideTurns.values()) count += controllers.size;
    return count;
  }

  function isRecoveryActive(chatKey) {
    return activeTurns.get(chatKey)?.currentPreparedTurn?.kind === "recovery";
  }

  async function startQueueDrainIfIdle(chatKey, ctx = null) {
    if (activeTurns.has(chatKey) || hasPendingFinalDelivery(chatKey) || isQueuePaused(chatKey)) {
      return false;
    }
    const runCtx = ctx ?? telegram.createSyntheticContext(chatKey);
    const firstTurn = await dequeuePendingTurn(chatKey, runCtx);
    if (!firstTurn) return false;

    const active = { abortController: null, stopRequested: false };
    activeTurns.set(chatKey, active);
    turns.runPreparedQueue(chatKey, firstTurn, active).catch(async (error) => {
      activeTurns.delete(chatKey);
      await telegram.replyHtml(
        runCtx,
        `<b>Queued Codex turn failed</b>\n${code(error instanceof Error ? error.message : String(error))}`
      ).catch(() => {});
    });
    return true;
  }

  function startPersistedQueues() {
    timers.setTimeout(() => {
      for (const chatKey of pendingTurns.keys()) {
        startQueueDrainIfIdle(chatKey).catch((error) => {
          logger.warn(
            "persisted queue start failed:",
            error instanceof Error ? error.message : String(error)
          );
        });
      }
    }, 3000);
  }

  function replaceQueue(chatKey, queue) {
    if (queue.length > 0) pendingTurns.set(chatKey, queue);
    else pendingTurns.delete(chatKey);
  }

  return {
    clearPendingTurns,
    clearRecoveryPendingTurns,
    countPendingTurns,
    countSideTurns,
    createQueueItemId,
    dequeuePendingTurn,
    enqueuePendingTurn,
    enqueuePendingTurnFront,
    getPendingTurns,
    getQueueMode,
    getSideTurnCount,
    hasPendingFinalDelivery,
    hydratePendingTurnsFromState,
    isQueuePaused,
    isRecoveryActive,
    movePendingTurn,
    persistPendingTurns,
    pruneExpiredPendingTurns,
    removePendingTurn,
    setQueueMode,
    setQueuePaused,
    startPersistedQueues,
    startQueueDrainIfIdle,
    stopSideTurns,
    trackSideTurn,
    untrackSideTurn
  };
}
