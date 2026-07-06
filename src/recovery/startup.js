import { buildRecoveryPrompt } from "./prompt.js";
import {
  clearRestartMarker,
  isRecoveryCandidateStale,
  readActiveTurnSnapshots,
  readRecoveryDedupe,
  readRestartMarker,
  recoveryCandidateFromSnapshot,
  recoveryKey,
  writeRecoveryDedupeAtomic
} from "./state.js";
import { appendRecoveryJournal } from "./journal.js";

export async function buildStartupRecoveryPlan(recoveryDir, options = {}) {
  const marker = await readRestartMarker(recoveryDir);
  const active = await readActiveTurnSnapshots(recoveryDir);
  const dedupe = await readRecoveryDedupe(recoveryDir);
  const candidates = mergeCandidates(marker, active, options.reason || "startup_recovery");
  const fresh = [];
  const stale = [];
  const suspended = [];

  for (const candidate of candidates) {
    if (isRecoveryCandidateStale(candidate, {
      now: options.now || new Date(),
      maxAgeSeconds: options.maxAgeSeconds ?? 21600
    })) {
      stale.push(candidate);
      continue;
    }
    const key = candidate.recoveryKey || recoveryKey(candidate);
    const attempts = Number(dedupe.recentRecoveryKeys?.[key]?.attempts ?? candidate.attempt ?? 0);
    if (attempts >= (options.suspendAfter ?? 3)) {
      suspended.push({ ...candidate, attempt: attempts });
      continue;
    }
    fresh.push({ ...candidate, recoveryKey: key, attempt: attempts });
  }

  return { marker, active, dedupe, candidates: fresh, stale, suspended };
}

export async function markRecoveryAttempt(recoveryDir, candidate, { status = "started", now = new Date() } = {}) {
  const dedupe = await readRecoveryDedupe(recoveryDir);
  const key = candidate.recoveryKey || recoveryKey(candidate);
  const previous = dedupe.recentRecoveryKeys[key] || { attempts: 0 };
  const failures = status === "failed" ? Number(previous.failures ?? 0) + 1 : Number(previous.failures ?? 0);
  const next = {
    ...previous,
    attempts: status === "started" ? Number(previous.attempts ?? 0) + 1 : Number(previous.attempts ?? 0),
    failures,
    warning: status === "failed" && failures >= 2,
    lastStatus: status,
    lastAttemptAt: now.toISOString()
  };
  dedupe.recentRecoveryKeys[key] = next;
  await writeRecoveryDedupeAtomic(recoveryDir, dedupe);
  await appendRecoveryJournal(recoveryDir, {
    type: `recovery_${status}`,
    chatKey: candidate.chatKey,
    threadId: candidate.threadId || "",
    reason: candidate.reason || "",
    recoveryKey: key,
    attempt: next.attempts
  });
  if (next.warning) {
    await appendRecoveryJournal(recoveryDir, {
      type: "recovery_failure_warning",
      chatKey: candidate.chatKey,
      threadId: candidate.threadId || "",
      reason: candidate.reason || "",
      recoveryKey: key,
      failures
    });
  }
  return next;
}

export async function hasRecoveryStartNoticeBeenSent(recoveryDir, candidate) {
  const dedupe = await readRecoveryDedupe(recoveryDir);
  const key = candidate.recoveryKey || recoveryKey(candidate);
  return Boolean(dedupe.recentRecoveryKeys[key]?.startNoticeSentAt);
}

export async function markRecoveryStartNoticeSent(recoveryDir, candidate, { now = new Date() } = {}) {
  const dedupe = await readRecoveryDedupe(recoveryDir);
  const key = candidate.recoveryKey || recoveryKey(candidate);
  const previous = dedupe.recentRecoveryKeys[key] || { attempts: 0 };
  dedupe.recentRecoveryKeys[key] = {
    ...previous,
    startNoticeSentAt: now.toISOString()
  };
  await writeRecoveryDedupeAtomic(recoveryDir, dedupe);
  return dedupe.recentRecoveryKeys[key];
}

export async function clearCompletedRecovery(recoveryDir) {
  await clearRestartMarker(recoveryDir);
}

export async function clearEmptyRestartMarker(recoveryDir, plan) {
  const marker = plan?.marker;
  if (!marker) return false;
  const hasRecoveryWork = [...(plan.candidates ?? []), ...(plan.stale ?? []), ...(plan.suspended ?? [])].length > 0;
  if (hasRecoveryWork) return false;
  await clearRestartMarker(recoveryDir);
  await appendRecoveryJournal(recoveryDir, {
    type: "restart_marker_cleared_empty",
    restartId: marker.restartId || "",
    mode: marker.mode || ""
  });
  return true;
}

export async function clearStaleRestartMarker(recoveryDir, plan) {
  const marker = plan?.marker;
  if (!marker || (plan.candidates ?? []).length > 0 || (plan.suspended ?? []).length > 0 || (plan.stale ?? []).length === 0) {
    return false;
  }
  await clearRestartMarker(recoveryDir);
  await appendRecoveryJournal(recoveryDir, {
    type: "restart_marker_cleared_stale",
    restartId: marker.restartId || "",
    mode: marker.mode || "",
    stale: plan.stale.length
  });
  return true;
}

export function buildStartupRecoveryActions(plan, options = {}) {
  const activeChatKeys = new Set(options.activeChatKeys ?? []);
  const restartId = plan?.marker?.restartId || options.restartId || "startup";
  const turns = [];
  const skippedActive = [];

  for (const candidate of plan?.candidates ?? []) {
    if (activeChatKeys.has(candidate.chatKey)) {
      skippedActive.push(candidate);
      continue;
    }
    turns.push(createRecoveryTurn(candidate, {
      restartId,
      ttlSeconds: options.ttlSeconds,
      workingDirectory: candidate.workingDirectory || options.workingDirectory,
      now: options.now
    }));
  }

  return {
    turns,
    skippedActive,
    stale: [...(plan?.stale ?? [])],
    suspended: [...(plan?.suspended ?? [])]
  };
}

export function applyRecoveryThreadToChatState(chatState, turn, options = {}) {
  const threadId = String(turn?.recovery?.threadId || "").trim();
  if (!threadId || !chatState || typeof chatState !== "object") return false;
  if (chatState.threadId === threadId) return false;
  chatState.threadId = threadId;
  chatState.updatedAt = (options.now || new Date()).toISOString();
  return true;
}

export function createRecoveryTurn(candidate, options = {}) {
  const enqueuedAt = options.now || new Date();
  const ttlSeconds = Math.max(0, Number(options.ttlSeconds ?? 86400));
  return {
    id: `recovery:${options.restartId || "startup"}:${candidate.chatKey}`,
    chatKey: candidate.chatKey,
    chatId: candidate.chatId ?? candidate.chatKey,
    messageThreadId: candidate.messageThreadId,
    replyToMessageId: candidate.replyToMessageId,
    originMessageId: candidate.originMessageId,
    originUpdateId: candidate.originUpdateId,
    kind: "recovery",
    recovery: {
      chatKey: candidate.chatKey,
      restartId: options.restartId || "",
      reason: candidate.reason || "startup_recovery",
      threadId: candidate.threadId || "",
      recoveryKey: candidate.recoveryKey || recoveryKey(candidate)
    },
    text: "Automatic restart recovery",
    inputText: buildRecoveryPrompt(candidate, options),
    imagePaths: [],
    enqueuedAt: enqueuedAt.toISOString(),
    expiresAt: new Date(enqueuedAt.getTime() + ttlSeconds * 1000).toISOString()
  };
}

function mergeCandidates(marker, active, fallbackReason) {
  const byIdentity = new Map();
  for (const candidate of marker?.recoveries ?? []) {
    const normalized = {
      ...candidate,
      reason: candidate.reason || marker?.mode || fallbackReason,
      recoveryKey: candidate.recoveryKey || recoveryKey(candidate),
      createdAt: marker?.createdAt || candidate.createdAt || ""
    };
    byIdentity.set(candidateIdentityKey(normalized), normalized);
  }
  for (const snapshot of Object.values(active?.turns ?? {})) {
    const candidate = recoveryCandidateFromSnapshot(snapshot, fallbackReason);
    if (!candidate) continue;
    const key = candidateIdentityKey(candidate);
    byIdentity.set(key, { ...candidate, ...byIdentity.get(key) });
  }
  return [...byIdentity.values()];
}

function candidateIdentityKey(candidate) {
  return `${candidate.chatKey}:${candidate.threadId || "no-thread"}`;
}
