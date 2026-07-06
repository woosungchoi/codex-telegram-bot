import test from "node:test";
import assert from "node:assert/strict";
import {
  buildUploadCleanupPlan,
  confirmUploadCleanupPlan,
  createUploadCleanupPlanId,
  createUploadCleanupPlanLogEntry,
  createUploadCleanupPlanRecord,
  createUploadCleanupResultLogEntry,
  deleteUploadCandidates,
  selectUploadCleanupCandidates,
  shouldRunUploadCleanup
} from "../src/uploads.js";

const now = new Date("2026-06-03T00:00:00.000Z");

function upload(name, ageDays, bytes) {
  return {
    path: `/uploads/${name}`,
    bytes,
    mtimeMs: now.getTime() - ageDays * 86_400_000
  };
}

test("old upload files become cleanup candidates", () => {
  const result = selectUploadCleanupCandidates([upload("old.jpg", 8, 100)], {
    now,
    retentionDays: 7,
    maxBytes: 0
  });
  assert.deepEqual(result.candidates.map((item) => item.path), ["/uploads/old.jpg"]);
});

test("old PDF upload files become cleanup candidates", () => {
  const result = selectUploadCleanupCandidates([upload("old.pdf", 8, 100)], {
    now,
    retentionDays: 7,
    maxBytes: 0
  });
  assert.deepEqual(result.candidates.map((item) => item.path), ["/uploads/old.pdf"]);
});

test("recent upload files are preserved", () => {
  const result = selectUploadCleanupCandidates([upload("recent.jpg", 2, 100)], {
    now,
    retentionDays: 7,
    maxBytes: 0
  });
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.preserved.map((item) => item.path), ["/uploads/recent.jpg"]);
});

test("max byte pressure selects oldest uploads first", () => {
  const result = selectUploadCleanupCandidates([
    upload("new.jpg", 1, 600),
    upload("old.jpg", 3, 600),
    upload("older.jpg", 5, 600)
  ], {
    now,
    retentionDays: 30,
    maxBytes: 1000
  });
  assert.deepEqual(result.candidates.map((item) => item.path), ["/uploads/older.jpg", "/uploads/old.jpg"]);
});

test("dry-run upload cleanup plan summarizes candidates without deleting", () => {
  const plan = buildUploadCleanupPlan([upload("old.jpg", 8, 100)], {
    now,
    retentionDays: 7,
    maxBytes: 0,
    dryRun: true
  });
  assert.equal(plan.dryRun, true);
  assert.equal(plan.candidates.length, 1);
  assert.equal(plan.candidateBytes, 100);
});

test("upload cleanup plan id is stable for supplied inputs", () => {
  assert.equal(createUploadCleanupPlanId(now, "abcd1234"), "20260603T000000000Z-abcd1234");
});

test("upload cleanup plan record carries an expiry", () => {
  const plan = buildUploadCleanupPlan([upload("old.jpg", 8, 100)], {
    now,
    retentionDays: 7,
    maxBytes: 0
  });
  const record = createUploadCleanupPlanRecord(plan, {
    now,
    ttlMs: 60_000,
    id: "plan-1"
  });
  assert.equal(record.id, "plan-1");
  assert.equal(record.expiresAt, "2026-06-03T00:01:00.000Z");
});

test("expired upload cleanup plan confirmation is rejected", () => {
  const plan = buildUploadCleanupPlan([upload("old.jpg", 8, 100)], { now, retentionDays: 7 });
  const record = createUploadCleanupPlanRecord(plan, { now, ttlMs: 1, id: "plan-1" });
  const result = confirmUploadCleanupPlan(record, { now: new Date("2026-06-03T00:00:01.000Z") });
  assert.deepEqual(result, { ok: false, reason: "expired_plan" });
});

test("missing upload cleanup plan confirmation is rejected", () => {
  assert.deepEqual(confirmUploadCleanupPlan(undefined, { now }), { ok: false, reason: "missing_plan" });
});

test("deleteUploadCandidates does not remove files in dry-run mode", async () => {
  const removed = [];
  const result = await deleteUploadCandidates([{ path: "/uploads/old.jpg", bytes: 100 }], {
    dryRun: true,
    removeFile: async (file) => removed.push(file)
  });
  assert.deepEqual(removed, []);
  assert.equal(result.deleted, 0);
  assert.equal(result.skipped, 1);
});

test("confirmed upload cleanup deletes only through explicit confirmation", async () => {
  const removed = [];
  const plan = buildUploadCleanupPlan([upload("old.jpg", 8, 100)], {
    now,
    retentionDays: 7,
    maxBytes: 0
  });
  const record = createUploadCleanupPlanRecord(plan, { now, id: "plan-1" });
  const confirmed = confirmUploadCleanupPlan(record, { now });
  assert.equal(confirmed.ok, true);
  const result = await deleteUploadCandidates(confirmed.plan.candidates, {
    dryRun: false,
    rootDir: "/uploads",
    removeFile: async (file) => removed.push(file)
  });
  assert.deepEqual(removed, ["/uploads/old.jpg"]);
  assert.equal(result.deleted, 1);
});

test("deleteUploadCandidates rejects candidates outside the upload directory", async () => {
  const removed = [];
  const result = await deleteUploadCandidates([{ path: "/etc/passwd", bytes: 100 }], {
    dryRun: false,
    rootDir: "/uploads",
    removeFile: async (file) => removed.push(file)
  });
  assert.deepEqual(removed, []);
  assert.equal(result.deleted, 0);
  assert.equal(result.skipped, 1);
  assert.equal(result.errors[0].message, "upload cleanup candidate is outside upload directory");
});

test("upload cleanup scheduler requires both cleanup and upload cleanup enabled", () => {
  assert.equal(shouldRunUploadCleanup({ cleanupEnabled: true, uploadCleanupEnabled: true }), true);
  assert.equal(shouldRunUploadCleanup({ cleanupEnabled: false, uploadCleanupEnabled: true }), false);
  assert.equal(shouldRunUploadCleanup({ cleanupEnabled: true, uploadCleanupEnabled: false }), false);
});

test("upload cleanup log entries include plan and result metadata", () => {
  const plan = buildUploadCleanupPlan([upload("old.jpg", 8, 100)], {
    now,
    retentionDays: 7,
    maxBytes: 0
  });
  assert.deepEqual(createUploadCleanupPlanLogEntry(plan, { planId: "plan-1", at: now.toISOString() }), {
    type: "upload_cleanup_plan",
    planId: "plan-1",
    dryRun: true,
    candidates: 1,
    candidateBytes: 100,
    totalBytes: 100,
    at: "2026-06-03T00:00:00.000Z"
  });
  assert.deepEqual(createUploadCleanupResultLogEntry("plan-1", plan, { deleted: 1, skipped: 0, errors: [] }, { at: now.toISOString() }), {
    type: "upload_cleanup",
    planId: "plan-1",
    result: { deleted: 1, skipped: 0, errors: [] },
    candidates: 1,
    candidateBytes: 100,
    at: "2026-06-03T00:00:00.000Z"
  });
});
