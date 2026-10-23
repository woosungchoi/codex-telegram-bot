import { provenanceFields } from "../authorization.js";
import {
  createRestartId,
  readActiveTurnSnapshots,
  recoveryCandidateFromSnapshot,
  writeRestartMarkerAtomic
} from "./state.js";
import { appendRecoveryJournal } from "./journal.js";

export async function createRestartMarkerFromActiveTurns(recoveryDir, options = {}) {
  const now = options.now || new Date();
  const restartId = options.restartId || createRestartId(now);
  const activeSnapshots = await readActiveTurnSnapshots(recoveryDir);
  const reason = options.reason || "self_restart";
  const recoveries = Object.values(activeSnapshots.turns ?? {})
    .map((snapshot) => recoveryCandidateFromSnapshot(snapshot, reason))
    .filter(Boolean);

  const marker = {
    version: 1,
    restartId,
    createdAt: now.toISOString(),
    mode: options.mode || "sigusr1",
    requestedBy: options.requestedBy || "signal",
    exitCode: options.exitCode ?? 75,
    notify: normalizeNotify(options.notify),
    recoveries
  };
  await writeRestartMarkerAtomic(recoveryDir, marker);
  await appendRecoveryJournal(recoveryDir, {
    type: "restart_marker_written",
    restartId,
    mode: marker.mode,
    requestedBy: marker.requestedBy,
    recoveries: recoveries.length
  });
  return marker;
}

export function normalizeNotify(notify = {}) {
  if (!notify || typeof notify !== "object") return null;
  if (notify.chatId == null) return null;
  return {
    ...provenanceFields(notify),
    chatId: notify.chatId,
    messageThreadId: notify.messageThreadId,
    replyToMessageId: notify.replyToMessageId
  };
}

export function shouldSuspendRecovery(dedupeEntry, { suspendAfter = 3 } = {}) {
  return Number(dedupeEntry?.attempts ?? 0) >= suspendAfter;
}
