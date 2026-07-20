export function planIncomingTurn({ active, pendingDelivery, paused, pendingCount, queueMode }) {
  if (pendingDelivery) return "enqueue_back";
  if (active) {
    if (queueMode === "interrupt") return "enqueue_front_interrupt";
    if (queueMode === "side") return "start_side";
    return "enqueue_back";
  }
  if (paused && pendingCount > 0) return "enqueue_back";
  return "start_now";
}

export function enqueueTurn(queue, turn, { max, front = false } = {}) {
  const limit = Math.max(0, Number(max ?? 0));
  if (queue.length >= limit) return { ok: false, queue, position: 0 };
  const nextQueue = front ? [turn, ...queue] : [...queue, turn];
  return {
    ok: true,
    queue: nextQueue,
    position: front ? 1 : nextQueue.length
  };
}

export function dequeueNextTurn(queue, options = {}) {
  const nextQueue = [...queue];
  let turn = null;
  let expired = 0;
  while (nextQueue.length > 0) {
    const candidate = nextQueue.shift();
    if (isPendingTurnExpired(candidate, options)) {
      expired += 1;
      continue;
    }
    turn = candidate;
    break;
  }
  return { turn, queue: nextQueue, expired };
}

export function removeTurn(queue, selector) {
  const index = findPendingTurnIndex(queue, selector);
  if (index < 0) return { changed: 0, queue };
  const nextQueue = [...queue];
  nextQueue.splice(index, 1);
  return { changed: 1, queue: nextQueue };
}

export function removeRecoveryTurns(queue) {
  const nextQueue = queue.filter((turn) => turn?.kind !== "recovery");
  return {
    changed: queue.length - nextQueue.length,
    queue: nextQueue
  };
}

export function moveTurn(queue, selector, direction) {
  const index = findPendingTurnIndex(queue, selector);
  if (index < 0) return { changed: 0, queue };
  const nextQueue = [...queue];
  if (direction === "next") {
    const [turn] = nextQueue.splice(index, 1);
    nextQueue.unshift(turn);
    return { changed: 1, queue: nextQueue };
  }
  if (direction === "up" && index > 0) {
    [nextQueue[index - 1], nextQueue[index]] = [nextQueue[index], nextQueue[index - 1]];
    return { changed: 1, queue: nextQueue };
  }
  return { changed: 0, queue };
}

export function pruneExpiredTurns(queue, options = {}) {
  const fresh = queue.filter((turn) => !isPendingTurnExpired(turn, options));
  return {
    queue: fresh,
    expired: queue.length - fresh.length
  };
}

export function hydratePendingQueues(queues, options = {}) {
  const pending = new Map();
  const normalizedQueues = {};
  for (const [chatKey, queue] of Object.entries(queues ?? {})) {
    if (!Array.isArray(queue)) continue;
    const hydrated = queue
      .map((turn) => normalizePendingTurn(turn, { ...options, chatKey }))
      .filter(Boolean)
      .filter((turn) => !isPendingTurnExpired(turn, options));
    if (hydrated.length > 0) {
      pending.set(chatKey, hydrated);
      normalizedQueues[chatKey] = hydrated.map(serializePendingTurn);
    }
  }
  return { pending, queues: normalizedQueues };
}

export function normalizePendingTurn(turn, options = {}) {
  if (!turn || typeof turn !== "object" || typeof turn.inputText !== "string") return null;
  const now = options.now ?? new Date();
  const enqueuedAt = Number.isNaN(Date.parse(turn.enqueuedAt)) ? now.toISOString() : turn.enqueuedAt;
  const maxAgeSeconds = Math.max(0, Number(options.maxAgeSeconds ?? 0));
  const expiresAt = Number.isNaN(Date.parse(turn.expiresAt))
    ? new Date(Date.parse(enqueuedAt) + maxAgeSeconds * 1000).toISOString()
    : turn.expiresAt;
  return {
    id: typeof turn.id === "string" && turn.id ? turn.id : options.createId?.() ?? "",
    chatKey: options.chatKey,
    chatId: turn.chatId ?? options.chatKey,
    messageThreadId: normalizeOptionalInteger(turn.messageThreadId),
    replyToMessageId: normalizeOptionalInteger(turn.replyToMessageId),
    originMessageId: normalizeOptionalInteger(turn.originMessageId),
    originUpdateId: normalizeOptionalInteger(turn.originUpdateId),
    kind: typeof turn.kind === "string" && turn.kind ? turn.kind : "user",
    recovery: turn.recovery && typeof turn.recovery === "object" ? { ...turn.recovery } : undefined,
    text: typeof turn.text === "string" ? turn.text : turn.inputText,
    inputText: turn.inputText,
    imagePaths: Array.isArray(turn.imagePaths) ? turn.imagePaths.filter((entry) => typeof entry === "string") : [],
    enqueuedAt,
    expiresAt
  };
}

export function serializePendingTurn(turn) {
  return {
    id: turn.id,
    chatKey: turn.chatKey,
    chatId: turn.chatId,
    messageThreadId: turn.messageThreadId,
    replyToMessageId: turn.replyToMessageId,
    originMessageId: turn.originMessageId,
    originUpdateId: turn.originUpdateId,
    kind: turn.kind,
    recovery: turn.recovery,
    text: turn.text,
    inputText: turn.inputText,
    imagePaths: turn.imagePaths,
    enqueuedAt: turn.enqueuedAt,
    expiresAt: turn.expiresAt
  };
}

export function isPendingTurnExpired(turn, { now = new Date(), maxAgeSeconds = 0 } = {}) {
  if (maxAgeSeconds <= 0) return false;
  const expiresAt = Date.parse(turn?.expiresAt ?? "");
  return Number.isFinite(expiresAt) && expiresAt <= now.getTime();
}

function findPendingTurnIndex(queue, selector) {
  const value = String(selector ?? "").trim();
  if (!value) return -1;
  if (/^\d+$/.test(value)) {
    const index = Number(value) - 1;
    if (index >= 0 && index < queue.length) return index;
  }
  return queue.findIndex((turn) => turn.id === value);
}

function normalizeOptionalInteger(value) {
  if (value == null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}
