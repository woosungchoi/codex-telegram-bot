import test from "node:test";
import assert from "node:assert/strict";
import {
  WORKER_DELIVERY_SCHEMA_VERSION,
  classifyWorkerDeliveryRecovery,
  hasPendingWorkerDelivery,
  isWorkerSnapshotResumeEligible,
  markWorkerDeliveryFailed,
  markWorkerDeliveryResultReady,
  markWorkerDeliverySending,
  markWorkerDeliverySent,
  markWorkerDeliveryStreaming,
  mergeWorkerDeliveryCursor,
  normalizeWorkerDeliveryEntry,
  parseWorkerDeliveryKey,
  pruneWorkerDeliveries,
  selectWorkerDeliveryCandidates,
  summarizeWorkerDeliveryStatus,
  workerDeliveryDigestMatches,
  workerDeliveryKey
} from "../src/worker/delivery.js";

const NOW = new Date("2026-07-20T05:00:00.000Z");
const RECENT = "2026-07-20T04:57:20.000Z";
const STALE = "2026-07-14T04:57:20.000Z";

function completedJob(overrides = {}) {
  return {
    id: "job-1",
    status: "completed",
    lastSeq: 38,
    completedAt: RECENT,
    updatedAt: RECENT,
    ...overrides
  };
}

test("delivery keys round-trip chat keys containing topic separators", () => {
  const key = workerDeliveryKey("chat-1:topic-2", "job-1");
  assert.equal(key, "chat-1:topic-2:job-1");
  assert.deepEqual(parseWorkerDeliveryKey(key), { chatKey: "chat-1:topic-2", jobId: "job-1" });
  assert.equal(parseWorkerDeliveryKey("malformed"), null);
});

test("legacy cursor entries normalize without losing unknown safe metadata", () => {
  const entry = normalizeWorkerDeliveryEntry("chat-1:job-1", {
    seq: 4,
    updatedAt: RECENT,
    futureField: "preserve"
  });
  assert.equal(entry.schemaVersion, 1);
  assert.equal(entry.deliveryStatus, "legacy_unknown");
  assert.equal(entry.chatKey, "chat-1");
  assert.equal(entry.jobId, "job-1");
  assert.equal(entry.seq, 4);
  assert.equal(entry.futureField, "preserve");
  assert.equal(normalizeWorkerDeliveryEntry("bad", { seq: 1 }), null);
  assert.equal(normalizeWorkerDeliveryEntry("chat-1:job-1", null), null);

  const canonical = normalizeWorkerDeliveryEntry("chat-1:job-1", {
    chatKey: "wrong-chat",
    jobId: "wrong-job",
    seq: 2
  });
  assert.equal(canonical.chatKey, "chat-1");
  assert.equal(canonical.jobId, "job-1");
});

test("cursor merge preserves delivery metadata and does not move backward", () => {
  const entry = {
    schemaVersion: 2,
    chatKey: "chat-1",
    jobId: "job-1",
    seq: 10,
    deliveryStatus: "result_ready",
    responseDigest: "sha256:abc",
    futureField: true
  };
  const merged = mergeWorkerDeliveryCursor(entry, { seq: 8 }, { now: NOW });
  assert.equal(merged.seq, 10);
  assert.equal(merged.deliveryStatus, "result_ready");
  assert.equal(merged.responseDigest, "sha256:abc");
  assert.equal(merged.futureField, true);
  assert.equal(merged.updatedAt, NOW.toISOString());
});

test("delivery lifecycle separates worker completion from Telegram delivery", () => {
  const streaming = markWorkerDeliveryStreaming(null, {
    chatKey: "chat-1",
    jobId: "job-1"
  }, { now: NOW });
  assert.equal(streaming.schemaVersion, WORKER_DELIVERY_SCHEMA_VERSION);
  assert.equal(streaming.deliveryStatus, "streaming");
  assert.equal(streaming.attemptCount, 0);
  assert.equal(streaming.ambiguous, false);

  const ready = markWorkerDeliveryResultReady(streaming, {
    seq: 38,
    responseDigest: "sha256:abc",
    responseLength: 410
  }, { now: NOW });
  assert.equal(ready.deliveryStatus, "result_ready");
  assert.equal(ready.seq, 38);
  assert.equal(ready.responseDigest, "sha256:abc");
  assert.equal(ready.responseLength, 410);
  assert.equal(Object.hasOwn(ready, "response"), false);

  const sending = markWorkerDeliverySending(ready, { now: NOW });
  assert.equal(sending.deliveryStatus, "delivery_sending");
  assert.equal(sending.attemptCount, 1);
  assert.equal(sending.lastAttemptAt, NOW.toISOString());
  assert.equal(sending.ambiguous, true);

  const failed = markWorkerDeliveryFailed(sending, {
    kind: "transport",
    code: "ETIMEDOUT",
    description: "request failed",
    ambiguous: true,
    requestBody: "must not persist",
    response: { body: "must not persist" }
  }, { now: NOW });
  assert.equal(failed.deliveryStatus, "delivery_failed");
  assert.equal(failed.ambiguous, true);
  assert.deepEqual(failed.lastError, {
    kind: "transport",
    code: "ETIMEDOUT",
    description: "request failed",
    ambiguous: true
  });
  assert.equal(Object.hasOwn(failed.lastError, "requestBody"), false);
  assert.equal(Object.hasOwn(failed.lastError, "response"), false);

  const sent = markWorkerDeliverySent(sending, { messageId: 99 }, { now: NOW });
  assert.equal(sent.deliveryStatus, "delivery_sent");
  assert.equal(sent.ambiguous, false);
  assert.equal(sent.sentAt, NOW.toISOString());
  assert.equal(sent.telegramMessageId, 99);
});

test("a recent current legacy cursor gap is a safe replay candidate", () => {
  const result = classifyWorkerDeliveryRecovery({
    entry: { seq: 4, updatedAt: RECENT },
    key: "chat-1:job-1",
    job: completedJob(),
    snapshot: {
      chatKey: "chat-1",
      workerJobId: "job-1",
      recoveryEligible: false,
      lastKnownStatus: "failed",
      lastEventAt: RECENT
    }
  }, { now: NOW, maxAgeSeconds: 21_600 });
  assert.equal(result.safe, true);
  assert.equal(result.manual, false);
  assert.equal(result.reason, "legacy_cursor_gap");
});

test("a legacy cursor that already observed terminal is never auto-replayed", () => {
  const result = classifyWorkerDeliveryRecovery({
    entry: { seq: 38, updatedAt: RECENT },
    key: "chat-1:job-1",
    job: completedJob(),
    snapshot: { workerJobId: "job-1", recoveryEligible: true, lastEventAt: RECENT }
  }, { now: NOW, maxAgeSeconds: 21_600 });
  assert.equal(result.safe, false);
  assert.equal(result.reason, "legacy_terminal_seen");
});

test("stale or unowned legacy gaps are not auto-replayed", () => {
  const stale = classifyWorkerDeliveryRecovery({
    entry: { seq: 4, updatedAt: STALE },
    key: "chat-1:job-1",
    job: completedJob({ completedAt: STALE, updatedAt: STALE }),
    snapshot: { workerJobId: "job-1", lastEventAt: STALE }
  }, { now: NOW, maxAgeSeconds: 21_600 });
  assert.equal(stale.safe, false);
  assert.equal(stale.reason, "stale");

  const unowned = classifyWorkerDeliveryRecovery({
    entry: { seq: 4, updatedAt: RECENT },
    key: "chat-1:job-1",
    job: completedJob(),
    snapshot: null
  }, { now: NOW, maxAgeSeconds: 21_600 });
  assert.equal(unowned.safe, false);
  assert.equal(unowned.reason, "legacy_not_current");
});

test("worker and snapshot identity mismatches are never auto-replayed", () => {
  const wrongJobChat = classifyWorkerDeliveryRecovery({
    entry: { schemaVersion: 2, chatKey: "chat-1", jobId: "job-1", seq: 38, deliveryStatus: "result_ready", updatedAt: RECENT },
    job: completedJob({ chatKey: "chat-2" })
  }, { now: NOW, maxAgeSeconds: 21_600 });
  assert.equal(wrongJobChat.safe, false);
  assert.equal(wrongJobChat.manual, true);
  assert.equal(wrongJobChat.reason, "job_identity_mismatch");

  const wrongSnapshotChat = selectWorkerDeliveryCandidates({
    "chat-1:job-1": { seq: 4, updatedAt: RECENT }
  }, { "job-1": completedJob({ chatKey: "chat-1" }) }, {
    snapshots: [{ chatKey: "chat-2", workerJobId: "job-1", recoveryEligible: true, lastEventAt: RECENT }],
    now: NOW,
    maxAgeSeconds: 21_600
  });
  assert.equal(wrongSnapshotChat.safe.length, 0);
  assert.equal(wrongSnapshotChat.ignored[0].reason, "legacy_not_current");
});

test("a user-stopped snapshot cannot authorize a legacy replay", () => {
  const result = classifyWorkerDeliveryRecovery({
    entry: { seq: 4, updatedAt: RECENT },
    key: "chat-1:job-1",
    job: completedJob(),
    snapshot: {
      workerJobId: "job-1",
      recoveryEligible: false,
      lastKnownStatus: "stopped",
      lastEventAt: RECENT
    }
  }, { now: NOW, maxAgeSeconds: 21_600 });
  assert.equal(result.safe, false);
  assert.equal(result.manual, false);
  assert.equal(result.reason, "recovery_disabled");
});

test("explicit result-ready is safe but ambiguous and sent states are not", () => {
  const base = {
    schemaVersion: 2,
    chatKey: "chat-1",
    jobId: "job-1",
    seq: 38,
    updatedAt: RECENT
  };
  const ready = classifyWorkerDeliveryRecovery({
    entry: { ...base, deliveryStatus: "result_ready", responseDigest: "sha256:abc" },
    job: completedJob()
  }, { now: NOW, maxAgeSeconds: 21_600 });
  assert.equal(ready.safe, true);
  assert.equal(ready.reason, "result_ready");

  for (const deliveryStatus of ["delivery_sending", "delivery_failed"]) {
    const ambiguous = classifyWorkerDeliveryRecovery({
      entry: { ...base, deliveryStatus, ambiguous: true },
      job: completedJob()
    }, { now: NOW, maxAgeSeconds: 21_600 });
    assert.equal(ambiguous.safe, false);
    assert.equal(ambiguous.manual, true);
    assert.equal(ambiguous.reason, "ambiguous_delivery");
  }

  const sent = classifyWorkerDeliveryRecovery({
    entry: { ...base, deliveryStatus: "delivery_sent", sentAt: RECENT },
    job: completedJob()
  }, { now: NOW, maxAgeSeconds: 21_600 });
  assert.equal(sent.safe, false);
  assert.equal(sent.manual, false);
  assert.equal(sent.reason, "already_sent");
});

test("candidate selection deduplicates jobs and returns safe versus manual review", () => {
  const deliveries = {
    "chat-1:job-1": { schemaVersion: 2, chatKey: "chat-1", jobId: "job-1", seq: 38, deliveryStatus: "result_ready", updatedAt: RECENT },
    "chat-2:job-2": { schemaVersion: 2, chatKey: "chat-2", jobId: "job-2", seq: 12, deliveryStatus: "delivery_sending", ambiguous: true, updatedAt: RECENT }
  };
  const result = selectWorkerDeliveryCandidates(deliveries, {
    "job-1": completedJob(),
    "job-2": completedJob({ id: "job-2", lastSeq: 12 })
  }, { now: NOW, maxAgeSeconds: 21_600 });
  assert.deepEqual(result.safe.map((entry) => entry.jobId), ["job-1"]);
  assert.deepEqual(result.manual.map((entry) => entry.jobId), ["job-2"]);
});

test("candidate dedupe prefers explicit and conservative delivery states", () => {
  const job = completedJob();
  const snapshots = {
    "chat-legacy": { workerJobId: "job-1", recoveryEligible: true, lastEventAt: RECENT }
  };
  const explicit = selectWorkerDeliveryCandidates({
    "chat-legacy:job-1": { seq: 4, updatedAt: RECENT },
    "chat-ready:job-1": {
      schemaVersion: 2,
      chatKey: "chat-ready",
      jobId: "job-1",
      seq: 38,
      deliveryStatus: "result_ready",
      updatedAt: RECENT
    }
  }, { "job-1": job }, { snapshots, now: NOW, maxAgeSeconds: 21_600 });
  assert.equal(explicit.safe.length, 1);
  assert.equal(explicit.safe[0].chatKey, "chat-ready");
  assert.equal(explicit.safe[0].reason, "result_ready");

  const sentWins = selectWorkerDeliveryCandidates({
    "chat-ready:job-1": {
      schemaVersion: 2,
      chatKey: "chat-ready",
      jobId: "job-1",
      seq: 38,
      deliveryStatus: "result_ready",
      updatedAt: RECENT
    },
    "chat-sent:job-1": {
      schemaVersion: 2,
      chatKey: "chat-sent",
      jobId: "job-1",
      seq: 38,
      deliveryStatus: "delivery_sent",
      updatedAt: RECENT
    }
  }, { "job-1": job }, { now: NOW, maxAgeSeconds: 21_600 });
  assert.equal(sentWins.safe.length, 0);
  assert.equal(sentWins.ignored[0].reason, "already_sent");
});

test("only eligible snapshots resume accepted or running worker jobs", () => {
  const running = { id: "job-1", status: "running" };
  assert.equal(isWorkerSnapshotResumeEligible({ workerJobId: "job-1", recoveryEligible: true }, running), true);
  assert.equal(isWorkerSnapshotResumeEligible({ workerJobId: "job-1" }, { ...running, status: "accepted" }), true);
  assert.equal(isWorkerSnapshotResumeEligible({ workerJobId: "job-1", recoveryEligible: false }, running), false);
  assert.equal(isWorkerSnapshotResumeEligible({ workerJobId: "other", recoveryEligible: true }, running), false);
  assert.equal(isWorkerSnapshotResumeEligible({ workerJobId: "job-1", recoveryEligible: true }, { ...running, status: "completed" }), false);
});

test("pending delivery detection is chat-scoped", () => {
  const deliveries = {
    "chat-1:job-1": { chatKey: "chat-1", jobId: "job-1", deliveryStatus: "result_ready" },
    "chat-2:job-2": { chatKey: "chat-2", jobId: "job-2", deliveryStatus: "delivery_sent" }
  };
  assert.equal(hasPendingWorkerDelivery(deliveries, "chat-1"), true);
  assert.equal(hasPendingWorkerDelivery(deliveries, "chat-2"), false);
});

test("delivery status summary distinguishes safe pending from uncertain delivery", () => {
  const safe = summarizeWorkerDeliveryStatus({
    "chat-1:job-1": { chatKey: "chat-1", jobId: "job-1", deliveryStatus: "result_ready" },
    "chat-2:job-2": { chatKey: "chat-2", jobId: "job-2", deliveryStatus: "delivery_sent" }
  }, "chat-1");
  assert.deepEqual(safe, {
    count: 1,
    status: "pending",
    recovery: "safe_replay_available"
  });

  const uncertain = summarizeWorkerDeliveryStatus({
    "chat-1:job-1": { chatKey: "chat-1", jobId: "job-1", deliveryStatus: "result_ready" },
    "chat-1:job-2": { chatKey: "chat-1", jobId: "job-2", deliveryStatus: "delivery_sending", ambiguous: true }
  }, "chat-1");
  assert.deepEqual(uncertain, {
    count: 2,
    status: "uncertain",
    recovery: "automatic_replay_disabled"
  });

  const review = summarizeWorkerDeliveryStatus({
    "chat-1:job-1": { chatKey: "chat-1", jobId: "job-1", deliveryStatus: "delivery_failed", ambiguous: false }
  }, "chat-1");
  assert.deepEqual(review, {
    count: 1,
    status: "pending",
    recovery: "manual_review_required"
  });

  assert.deepEqual(summarizeWorkerDeliveryStatus({}, "chat-1"), {
    count: 0,
    status: "none",
    recovery: "none"
  });
});

test("delivery digest validation permits legacy entries and blocks mismatches", () => {
  assert.equal(workerDeliveryDigestMatches("", "sha256:new"), true);
  assert.equal(workerDeliveryDigestMatches("sha256:same", "sha256:same"), true);
  assert.equal(workerDeliveryDigestMatches("sha256:expected", "sha256:actual"), false);
});

test("pruning removes old sent and orphan legacy entries but preserves ambiguous delivery", () => {
  const result = pruneWorkerDeliveries({
    "chat-1:sent": { chatKey: "chat-1", jobId: "sent", seq: 10, deliveryStatus: "delivery_sent", sentAt: STALE, updatedAt: STALE },
    "chat-1:legacy": { seq: 4, updatedAt: STALE },
    "chat-1:ambiguous": { chatKey: "chat-1", jobId: "ambiguous", seq: 10, deliveryStatus: "delivery_failed", ambiguous: true, updatedAt: STALE },
    "chat-1:ready": { chatKey: "chat-1", jobId: "ready", seq: 10, deliveryStatus: "result_ready", updatedAt: STALE }
  }, {
    jobs: {},
    activeSnapshotJobIds: [],
    now: NOW,
    maxAgeSeconds: 21_600
  });
  assert.deepEqual(result.removed.sort(), ["chat-1:legacy", "chat-1:sent"]);
  assert.equal(Object.hasOwn(result.deliveries, "chat-1:ambiguous"), true);
  assert.equal(Object.hasOwn(result.deliveries, "chat-1:ready"), true);
});
