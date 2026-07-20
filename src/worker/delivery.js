export const WORKER_DELIVERY_SCHEMA_VERSION = 2;

const DELIVERY_STATUSES = new Set([
  "streaming",
  "result_ready",
  "delivery_sending",
  "delivery_failed",
  "delivery_sent",
  "legacy_unknown"
]);

const PENDING_DELIVERY_STATUSES = new Set([
  "result_ready",
  "delivery_sending",
  "delivery_failed"
]);

export function workerDeliveryKey(chatKey, jobId) {
  return `${String(chatKey || "")}:${String(jobId || "")}`;
}

export function parseWorkerDeliveryKey(key) {
  const value = String(key || "");
  const separator = value.lastIndexOf(":");
  if (separator <= 0 || separator === value.length - 1) return null;
  return {
    chatKey: value.slice(0, separator),
    jobId: value.slice(separator + 1)
  };
}

export function normalizeWorkerDeliveryEntry(key, value) {
  const parsed = parseWorkerDeliveryKey(key);
  if (!parsed || !value || typeof value !== "object" || Array.isArray(value)) return null;
  const explicitStatus = DELIVERY_STATUSES.has(value.deliveryStatus) ? value.deliveryStatus : "";
  const legacy = !explicitStatus;
  return {
    ...value,
    schemaVersion: legacy ? 1 : numericOr(value.schemaVersion, WORKER_DELIVERY_SCHEMA_VERSION),
    chatKey: parsed.chatKey,
    jobId: parsed.jobId,
    seq: nonNegativeNumber(value.seq),
    deliveryStatus: explicitStatus || "legacy_unknown"
  };
}

export function mergeWorkerDeliveryCursor(entry, patch = {}, { now = new Date() } = {}) {
  const base = objectOrEmpty(entry);
  return {
    ...base,
    ...patch,
    seq: Math.max(nonNegativeNumber(base.seq), nonNegativeNumber(patch.seq)),
    updatedAt: iso(now)
  };
}

export function markWorkerDeliveryStreaming(entry, metadata = {}, { now = new Date() } = {}) {
  const base = objectOrEmpty(entry);
  return {
    ...base,
    ...metadata,
    schemaVersion: WORKER_DELIVERY_SCHEMA_VERSION,
    chatKey: String(metadata.chatKey || base.chatKey || ""),
    jobId: String(metadata.jobId || base.jobId || ""),
    seq: Math.max(nonNegativeNumber(base.seq), nonNegativeNumber(metadata.seq)),
    deliveryStatus: "streaming",
    attemptCount: nonNegativeNumber(base.attemptCount),
    ambiguous: false,
    lastError: null,
    updatedAt: iso(now)
  };
}

export function markWorkerDeliveryResultReady(entry, result = {}, { now = new Date() } = {}) {
  const base = objectOrEmpty(entry);
  return {
    ...base,
    schemaVersion: WORKER_DELIVERY_SCHEMA_VERSION,
    seq: Math.max(nonNegativeNumber(base.seq), nonNegativeNumber(result.seq)),
    deliveryStatus: "result_ready",
    responseDigest: String(result.responseDigest || ""),
    responseLength: nonNegativeNumber(result.responseLength),
    resultReadyAt: iso(now),
    ambiguous: false,
    lastError: null,
    updatedAt: iso(now)
  };
}

export function markWorkerDeliverySending(entry, { now = new Date() } = {}) {
  const base = objectOrEmpty(entry);
  return {
    ...base,
    schemaVersion: WORKER_DELIVERY_SCHEMA_VERSION,
    deliveryStatus: "delivery_sending",
    attemptCount: nonNegativeNumber(base.attemptCount) + 1,
    lastAttemptAt: iso(now),
    ambiguous: true,
    updatedAt: iso(now)
  };
}

export function markWorkerDeliveryFailed(entry, errorSummary = {}, { now = new Date() } = {}) {
  const base = objectOrEmpty(entry);
  return {
    ...base,
    schemaVersion: WORKER_DELIVERY_SCHEMA_VERSION,
    deliveryStatus: "delivery_failed",
    ambiguous: errorSummary.ambiguous === true,
    lastError: compactErrorSummary(errorSummary),
    updatedAt: iso(now)
  };
}

export function markWorkerDeliverySent(entry, messageMetadata = {}, { now = new Date() } = {}) {
  const base = objectOrEmpty(entry);
  const messageId = numericOrNull(messageMetadata.messageId ?? messageMetadata.message_id);
  return {
    ...base,
    schemaVersion: WORKER_DELIVERY_SCHEMA_VERSION,
    deliveryStatus: "delivery_sent",
    ambiguous: false,
    lastError: null,
    sentAt: iso(now),
    ...(messageId === null ? {} : { telegramMessageId: messageId }),
    updatedAt: iso(now)
  };
}

export function classifyWorkerDeliveryRecovery(input = {}, { now = new Date(), maxAgeSeconds = 21_600 } = {}) {
  const entry = normalizeInputEntry(input);
  if (!entry) return classification(false, false, "invalid_entry");
  const job = input.job;
  const status = entry.deliveryStatus;

  if (status === "delivery_sent") return classification(false, false, "already_sent");
  if (status === "delivery_sending" || entry.ambiguous === true) {
    return classification(false, true, "ambiguous_delivery");
  }
  if (!job) return classification(false, false, "job_missing");
  if ((job.id && String(job.id) !== entry.jobId) || (job.chatKey && String(job.chatKey) !== entry.chatKey)) {
    return classification(false, true, "job_identity_mismatch");
  }
  if (job.status !== "completed") return classification(false, false, `job_${job.status || "not_completed"}`);
  if (isEntryStale(entry, job, input.snapshot, now, maxAgeSeconds)) {
    return classification(false, false, "stale");
  }
  if (status === "result_ready") return classification(true, false, "result_ready");
  if (status === "delivery_failed") return classification(false, true, "delivery_failed");

  const lastSeq = nonNegativeNumber(job.lastSeq);
  if (entry.seq >= lastSeq) return classification(false, false, "legacy_terminal_seen");
  if (!snapshotOwnsJob(input.snapshot, entry.jobId)) {
    return classification(false, false, status === "streaming" ? "streaming_not_current" : "legacy_not_current");
  }
  if (input.snapshot?.recoveryEligible === false && !isLegacyProgressFailureSnapshot(status, input.snapshot)) {
    return classification(false, false, "recovery_disabled");
  }
  // waitForWorkerJob persists each cursor before processing the event. A cursor
  // below a completed job's terminal seq therefore proves final delivery was
  // never reached, but only for the snapshot that still owns this exact job.
  return classification(true, false, status === "streaming" ? "streaming_cursor_gap" : "legacy_cursor_gap");
}

export function selectWorkerDeliveryCandidates(deliveries, jobs, options = {}) {
  const safe = [];
  const manual = [];
  const ignored = [];
  const seenJobIds = new Set();
  const entries = Object.entries(objectOrEmpty(deliveries))
    .map(([key, rawEntry]) => ({ key, entry: normalizeWorkerDeliveryEntry(key, rawEntry) }))
    .filter(({ entry }) => Boolean(entry))
    .sort((left, right) => (
      deliveryRecoveryPriority(right.entry) - deliveryRecoveryPriority(left.entry)
      || left.key.localeCompare(right.key)
    ));
  for (const { key, entry } of entries) {
    if (seenJobIds.has(entry.jobId)) continue;
    const job = jobById(jobs, entry.jobId);
    const snapshot = snapshotForJob(options.snapshots, entry.chatKey, entry.jobId);
    const result = classifyWorkerDeliveryRecovery(
      { key, entry, job, snapshot },
      { now: options.now, maxAgeSeconds: options.maxAgeSeconds }
    );
    const candidate = { key, chatKey: entry.chatKey, jobId: entry.jobId, entry, job, snapshot, ...result };
    seenJobIds.add(entry.jobId);
    if (result.safe) safe.push(candidate);
    else if (result.manual) manual.push(candidate);
    else ignored.push(candidate);
  }
  return { safe, manual, ignored };
}

export function isWorkerSnapshotResumeEligible(snapshot, job) {
  return Boolean(
    snapshot?.recoveryEligible !== false
    && snapshotOwnsJob(snapshot, job?.id)
    && (job?.status === "accepted" || job?.status === "running")
  );
}

export function pruneWorkerDeliveries(deliveries, options = {}) {
  const next = { ...objectOrEmpty(deliveries) };
  const removed = [];
  const activeSnapshotJobIds = new Set(options.activeSnapshotJobIds ?? []);
  const now = options.now instanceof Date ? options.now : new Date(options.now ?? Date.now());
  const maxAgeSeconds = numericOr(options.maxAgeSeconds, 21_600);

  for (const [key, rawEntry] of Object.entries(next)) {
    const entry = normalizeWorkerDeliveryEntry(key, rawEntry);
    if (!entry || activeSnapshotJobIds.has(entry.jobId)) continue;
    if (!olderThan(entry.updatedAt || entry.sentAt, now, maxAgeSeconds)) continue;
    if (entry.deliveryStatus === "delivery_sending" || entry.deliveryStatus === "delivery_failed" || entry.deliveryStatus === "result_ready") {
      continue;
    }
    const job = jobById(options.jobs, entry.jobId);
    const shouldRemove = entry.deliveryStatus === "delivery_sent"
      || (entry.deliveryStatus === "legacy_unknown" && !job)
      || ((job?.status === "failed" || job?.status === "cancelled") && entry.deliveryStatus !== "result_ready");
    if (!shouldRemove) continue;
    delete next[key];
    removed.push(key);
  }
  return { deliveries: next, removed };
}

export function hasPendingWorkerDelivery(deliveries, chatKey) {
  for (const [key, rawEntry] of Object.entries(objectOrEmpty(deliveries))) {
    const entry = normalizeWorkerDeliveryEntry(key, rawEntry);
    if (entry?.chatKey === chatKey && PENDING_DELIVERY_STATUSES.has(entry.deliveryStatus)) return true;
  }
  return false;
}

export function summarizeWorkerDeliveryStatus(deliveries, chatKey) {
  const pending = [];
  for (const [key, rawEntry] of Object.entries(objectOrEmpty(deliveries))) {
    const entry = normalizeWorkerDeliveryEntry(key, rawEntry);
    if (entry?.chatKey === chatKey && PENDING_DELIVERY_STATUSES.has(entry.deliveryStatus)) pending.push(entry);
  }
  if (pending.length === 0) {
    return { count: 0, status: "none", recovery: "none" };
  }

  const uncertain = pending.some((entry) => entry.deliveryStatus === "delivery_sending" || entry.ambiguous === true);
  const failed = pending.some((entry) => entry.deliveryStatus === "delivery_failed");
  return {
    count: pending.length,
    status: uncertain ? "uncertain" : "pending",
    recovery: uncertain
      ? "automatic_replay_disabled"
      : failed
        ? "manual_review_required"
        : "safe_replay_available"
  };
}

export function workerDeliveryDigestMatches(expectedDigest, actualDigest) {
  return !expectedDigest || String(expectedDigest) === String(actualDigest || "");
}

function normalizeInputEntry(input) {
  if (input.key) return normalizeWorkerDeliveryEntry(input.key, input.entry);
  const value = input.entry;
  if (!value || typeof value !== "object") return null;
  const key = value.chatKey && value.jobId ? workerDeliveryKey(value.chatKey, value.jobId) : "";
  return normalizeWorkerDeliveryEntry(key, value);
}

function compactErrorSummary(value) {
  return Object.fromEntries([
    ["kind", value.kind],
    ["code", value.code],
    ["errno", value.errno],
    ["type", value.type],
    ["description", value.description],
    ["retryAfter", value.retryAfter],
    ["ambiguous", value.ambiguous === true]
  ].filter(([, entry]) => entry !== undefined && entry !== null && entry !== ""));
}

function deliveryRecoveryPriority(entry) {
  if (entry.deliveryStatus === "delivery_sent") return 50;
  if (entry.deliveryStatus === "delivery_sending" || entry.deliveryStatus === "delivery_failed" || entry.ambiguous === true) return 40;
  if (entry.deliveryStatus === "result_ready") return 30;
  if (entry.deliveryStatus === "streaming") return 20;
  return 10;
}

function classification(safe, manual, reason) {
  return { safe, manual, reason };
}

function snapshotOwnsJob(snapshot, jobId) {
  return Boolean(snapshot && String(snapshot.workerJobId || "") === String(jobId || ""));
}

function isLegacyProgressFailureSnapshot(status, snapshot) {
  return status === "legacy_unknown" && snapshot?.lastKnownStatus === "failed";
}

function snapshotForJob(snapshots, chatKey, jobId) {
  if (!snapshots) return null;
  if (Array.isArray(snapshots)) {
    return snapshots.find((entry) => (
      String(entry?.chatKey || "") === chatKey && snapshotOwnsJob(entry, jobId)
    )) ?? null;
  }
  const direct = snapshots[chatKey];
  if (snapshotOwnsJob(direct, jobId)) return direct;
  return null;
}

function jobById(jobs, jobId) {
  if (!jobs) return null;
  if (Array.isArray(jobs)) return jobs.find((job) => String(job?.id || "") === jobId) ?? null;
  return jobs[jobId] ?? null;
}

function isEntryStale(entry, job, snapshot, nowValue, maxAgeSeconds) {
  if (maxAgeSeconds <= 0) return false;
  const now = nowValue instanceof Date ? nowValue : new Date(nowValue ?? Date.now());
  const timestamp = entry.updatedAt || entry.resultReadyAt || job?.completedAt || job?.updatedAt || snapshot?.lastEventAt || "";
  return olderThan(timestamp, now, maxAgeSeconds);
}

function olderThan(value, now, maxAgeSeconds) {
  if (maxAgeSeconds <= 0) return false;
  const timestamp = Date.parse(String(value || ""));
  if (!Number.isFinite(timestamp)) return false;
  return now.getTime() - timestamp > maxAgeSeconds * 1000;
}

function objectOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function nonNegativeNumber(value) {
  return Math.max(0, numericOr(value, 0));
}

function numericOr(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function numericOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function iso(now) {
  return (now instanceof Date ? now : new Date(now)).toISOString();
}
