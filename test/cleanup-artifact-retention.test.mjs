import test from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import {
  buildCleanupArtifactRetentionManifest,
  parseCleanupArtifactName,
  planCleanupLogRetention
} from "../scripts/cleanup_artifact_retention.mjs";
import { cleanupRestoreScript } from "../src/maintenance/cleanup.js";

const DAY_MS = 86_400_000;
const execFile = promisify(execFileCallback);

async function waitForPath(filePath, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fs.lstat(filePath);
      return;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${filePath}`);
}

async function setTreeMtime(root, date) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) await setTreeMtime(child, date);
    await fs.utimes(child, date, date);
  }
  await fs.utimes(root, date, date);
}

async function createArtifact(root, {
  dateKey,
  planId,
  action = "both",
  createdAt,
  expiresAt,
  mtime,
  errors = [],
  extraBytes = 0,
  restoreComplete = false
}) {
  const dir = path.join(root, `${dateKey}-${planId}-${action}`);
  await fs.mkdir(path.join(dir, "delete-backup"), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(dir, "plan.json"), `${JSON.stringify({ id: planId, createdAt, expiresAt })}\n`);
  await fs.writeFile(path.join(dir, "manifest.jsonl"), `${JSON.stringify({ type: "delete", from: "/old", backup: "/backup" })}\n`);
  await fs.writeFile(path.join(dir, "result.json"), `${JSON.stringify({ quarantined: 0, deleted: 1, skipped: 0, errors })}\n`);
  await fs.writeFile(path.join(dir, "restore-cleanup.py"), "# fixture\n");
  if (extraBytes > 0) {
    const handle = await fs.open(path.join(dir, "delete-backup", "sparse.bin"), "w");
    await handle.truncate(extraBytes);
    await handle.close();
  }
  if (restoreComplete) {
    await fs.writeFile(
      path.join(dir, "restore-complete.json"),
      `${JSON.stringify({ schema: "codex-cleanup-restore-complete/v1", status: "complete", completedAt: createdAt })}\n`
    );
  }
  await setTreeMtime(dir, mtime);
  return dir;
}

async function fixtureRoot(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "codex-artifact-retention-"));
  const artifactRoot = path.join(base, "cleanup-artifacts");
  await fs.mkdir(artifactRoot, { mode: 0o700 });
  const stateFile = path.join(base, "threads.json");
  const cleanupLogFile = path.join(base, "cleanup-log.jsonl");
  await fs.writeFile(stateFile, `${JSON.stringify({ cleanup: { plans: {} } })}\n`);
  await fs.writeFile(cleanupLogFile, "");
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  return { base, artifactRoot, stateFile, cleanupLogFile };
}

test("cleanup artifact name parser is top-level and action aware", () => {
  assert.deepEqual(parseCleanupArtifactName("2026-05-16-mp7kyhlv-sk6ycb-quarantine"), {
    dateKey: "2026-05-16",
    planId: "mp7kyhlv-sk6ycb",
    action: "quarantine"
  });
  for (const invalid of (
    ["nested/2026-05-16-plan-both", "2026-13-16-plan-both", "2026-05-16-plan-unknown", ".", "../plan"]
  )) {
    assert.throws(() => parseCleanupArtifactName(invalid));
  }
});

test("audit retains newest seven and selects only closed old top-level directories", async (t) => {
  const { artifactRoot, stateFile, cleanupLogFile } = await fixtureRoot(t);
  const asOf = new Date("2026-07-18T00:00:00Z");
  for (let index = 0; index < 10; index += 1) {
    const at = new Date(asOf.getTime() - (60 - index) * DAY_MS);
    await createArtifact(artifactRoot, {
      dateKey: at.toISOString().slice(0, 10),
      planId: `old-${index}`,
      createdAt: at.toISOString(),
      expiresAt: new Date(at.getTime() + DAY_MS).toISOString(),
      mtime: at
    });
  }
  const exactCutoff = new Date(asOf.getTime() - 30 * DAY_MS);
  await createArtifact(artifactRoot, {
    dateKey: exactCutoff.toISOString().slice(0, 10),
    planId: "exact-cutoff",
    createdAt: exactCutoff.toISOString(),
    expiresAt: new Date(exactCutoff.getTime() + DAY_MS).toISOString(),
    mtime: exactCutoff
  });
  for (let index = 0; index < 7; index += 1) {
    const at = new Date(asOf.getTime() - (index + 1) * DAY_MS);
    await createArtifact(artifactRoot, {
      dateKey: at.toISOString().slice(0, 10),
      planId: `new-${index}`,
      createdAt: at.toISOString(),
      expiresAt: new Date(at.getTime() + DAY_MS).toISOString(),
      mtime: at
    });
  }

  const manifest = await buildCleanupArtifactRetentionManifest({
    artifactRoot,
    stateFile,
    cleanupLogFile,
    asOf,
    maxAgeDays: 30,
    newestMinimum: 7,
    maxReclaimBytes: 1024 ** 3,
    cleanupLogRetentionDays: 180,
    activeReferencedDirs: []
  });

  assert.equal(manifest.schema, "codex-cleanup-artifact-retention/v1");
  assert.equal(manifest.mode, "audit-only");
  assert.equal(manifest.candidates.length, 10);
  assert.ok(manifest.candidates.every((row) => row.adapter === "codex-cleanup-artifact"));
  assert.equal(manifest.excluded.filter((row) => row.reason === "newest-minimum-7").length, 7);
  assert.ok(manifest.excluded.some((row) => (
    row.path.endsWith("-exact-cutoff-both") && row.reason === "entire-directory-within-retention"
  )));
  assert.equal(manifest.budget.blocked, false);
  assert.deepEqual(manifest.budget.approvedObjectIds, []);
  assert.deepEqual(manifest.actualDeletedObjectIds, []);
  assert.equal(manifest.actualReclaimedBytes, 0);
  assert.equal(manifest.applyEligibility.eligible, false);
});

test("active approval, restore marker, process reference, symlink, and errors fail closed", async (t) => {
  const { artifactRoot, stateFile, cleanupLogFile } = await fixtureRoot(t);
  const asOf = new Date("2026-07-18T00:00:00Z");
  const old = new Date(asOf.getTime() - 60 * DAY_MS);
  const activeDir = await createArtifact(artifactRoot, {
    dateKey: "2026-05-19",
    planId: "active-plan",
    createdAt: old.toISOString(),
    expiresAt: new Date(old.getTime() + DAY_MS).toISOString(),
    mtime: old
  });
  const restoreDir = await createArtifact(artifactRoot, {
    dateKey: "2026-05-20",
    planId: "restore-plan",
    createdAt: old.toISOString(),
    expiresAt: new Date(old.getTime() + DAY_MS).toISOString(),
    mtime: old
  });
  await fs.writeFile(path.join(restoreDir, ".restore-active.json"), "{}\n");
  await setTreeMtime(restoreDir, old);
  const referencedDir = await createArtifact(artifactRoot, {
    dateKey: "2026-05-21",
    planId: "referenced-plan",
    createdAt: old.toISOString(),
    expiresAt: new Date(old.getTime() + DAY_MS).toISOString(),
    mtime: old
  });
  const unsafeDir = await createArtifact(artifactRoot, {
    dateKey: "2026-05-22",
    planId: "unsafe-plan",
    createdAt: old.toISOString(),
    expiresAt: new Date(old.getTime() + DAY_MS).toISOString(),
    mtime: old,
    errors: ["partial cleanup"]
  });
  await fs.symlink("/tmp", path.join(unsafeDir, "delete-backup", "outside"));
  await fs.writeFile(
    stateFile,
    `${JSON.stringify({ cleanup: { plans: { "active-plan": { expiresAt: "2026-07-19T00:00:00Z" } } } })}\n`
  );

  const manifest = await buildCleanupArtifactRetentionManifest({
    artifactRoot,
    stateFile,
    cleanupLogFile,
    asOf,
    maxAgeDays: 30,
    newestMinimum: 0,
    maxReclaimBytes: 1024 ** 3,
    cleanupLogRetentionDays: 180,
    activeReferencedDirs: [referencedDir]
  });

  const reasons = new Map(manifest.excluded.map((row) => [row.path, row.reason]));
  assert.equal(reasons.get(activeDir), "active-approval-reference");
  assert.equal(reasons.get(restoreDir), "active-restore-marker");
  assert.equal(reasons.get(referencedDir), "active-process-reference");
  assert.ok(manifest.blockingFindings.some((row) => row.path === unsafeDir && row.reason.includes("symlink")));
  assert.equal(manifest.budget.blocked, true);
  assert.deepEqual(manifest.budget.approvedObjectIds, []);
});

test("malformed or noncanonical active approval TTL blocks the whole run with zero candidates", async (t) => {
  const { artifactRoot, stateFile, cleanupLogFile } = await fixtureRoot(t);
  const asOf = new Date("2026-07-18T00:00:00Z");
  const old = new Date(asOf.getTime() - 60 * DAY_MS);
  await createArtifact(artifactRoot, {
    dateKey: "2026-05-19",
    planId: "malformed-plan",
    createdAt: old.toISOString(),
    expiresAt: new Date(old.getTime() + DAY_MS).toISOString(),
    mtime: old
  });
  for (const expiresAt of [0, "0", "2025-01", "01/02/2025"]) {
    await fs.writeFile(
      stateFile,
      `${JSON.stringify({ cleanup: { plans: { "malformed-plan": { expiresAt } } } })}\n`
    );

    const manifest = await buildCleanupArtifactRetentionManifest({
      artifactRoot,
      stateFile,
      cleanupLogFile,
      asOf,
      maxAgeDays: 30,
      newestMinimum: 0,
      maxReclaimBytes: 1024 ** 3,
      cleanupLogRetentionDays: 180,
      activeReferencedDirs: []
    });
    const label = `expiresAt=${JSON.stringify(expiresAt)}`;

    assert.deepEqual(manifest.candidates, [], label);
    assert.ok(manifest.blockingFindings.some((row) => row.reason.includes("invalid cleanup.plans")), label);
    assert.equal(manifest.budget.blocked, true, label);
    assert.deepEqual(manifest.budget.approvedObjectIds, [], label);
  }
});

test("nested configured restore reference normalizes to its artifact and blocks the whole run", async (t) => {
  const { artifactRoot, stateFile, cleanupLogFile } = await fixtureRoot(t);
  const asOf = new Date("2026-07-18T00:00:00Z");
  const old = new Date(asOf.getTime() - 60 * DAY_MS);
  const referencedDir = await createArtifact(artifactRoot, {
    dateKey: "2026-05-19",
    planId: "nested-reference",
    createdAt: old.toISOString(),
    expiresAt: new Date(old.getTime() + DAY_MS).toISOString(),
    mtime: old
  });
  const nestedReference = path.join(referencedDir, "manifest.jsonl");
  await fs.writeFile(
    stateFile,
    `${JSON.stringify({ cleanup: { plans: {}, restoreRefs: [nestedReference] } })}\n`
  );

  const manifest = await buildCleanupArtifactRetentionManifest({
    artifactRoot,
    stateFile,
    cleanupLogFile,
    asOf,
    maxAgeDays: 30,
    newestMinimum: 0,
    maxReclaimBytes: 1024 ** 3,
    cleanupLogRetentionDays: 180,
    activeReferencedDirs: []
  });

  assert.deepEqual(manifest.candidates, []);
  assert.ok(manifest.blockingFindings.some((row) => (
    row.path === referencedDir && row.reason.includes("configured restore reference")
  )));
  assert.ok(manifest.excluded.some((row) => (
    row.path === referencedDir && row.reason === "active-configured-restore-reference"
  )));
  assert.deepEqual(manifest.budget.approvedObjectIds, []);

  await fs.writeFile(
    stateFile,
    `${JSON.stringify({ cleanup: { plans: {}, restoreRefs: [{ artifactDir: "" }] } })}\n`
  );
  const malformed = await buildCleanupArtifactRetentionManifest({
    artifactRoot,
    stateFile,
    cleanupLogFile,
    asOf,
    maxAgeDays: 30,
    newestMinimum: 0,
    maxReclaimBytes: 1024 ** 3,
    cleanupLogRetentionDays: 180,
    activeReferencedDirs: []
  });
  assert.deepEqual(malformed.candidates, []);
  assert.ok(malformed.blockingFindings.some((row) => (
    row.reason.includes("invalid configured restore reference")
  )));
  assert.deepEqual(malformed.budget.approvedObjectIds, []);
});

test("one gibibyte budget aborts the whole run instead of truncating", async (t) => {
  const { artifactRoot, stateFile, cleanupLogFile } = await fixtureRoot(t);
  const asOf = new Date("2026-07-18T00:00:00Z");
  const old = new Date(asOf.getTime() - 60 * DAY_MS);
  for (let index = 0; index < 2; index += 1) {
    await createArtifact(artifactRoot, {
      dateKey: `2026-05-${String(10 + index).padStart(2, "0")}`,
      planId: `large-${index}`,
      createdAt: old.toISOString(),
      expiresAt: new Date(old.getTime() + DAY_MS).toISOString(),
      mtime: old,
      extraBytes: 600 * 1024 ** 2
    });
  }

  const manifest = await buildCleanupArtifactRetentionManifest({
    artifactRoot,
    stateFile,
    cleanupLogFile,
    asOf,
    maxAgeDays: 30,
    newestMinimum: 0,
    maxReclaimBytes: 1024 ** 3,
    cleanupLogRetentionDays: 180,
    activeReferencedDirs: []
  });

  assert.equal(manifest.candidates.length, 2);
  assert.ok(manifest.budget.candidateBytes > 1024 ** 3);
  assert.equal(manifest.budget.blocked, true);
  assert.equal(manifest.budget.behavior, "abort-entire-run-never-truncate");
  assert.deepEqual(manifest.budget.approvedObjectIds, []);
});

test("cleanup JSONL audit plans monthly rotation and 180-day archive retention", async (t) => {
  const { base, cleanupLogFile } = await fixtureRoot(t);
  await fs.writeFile(
    cleanupLogFile,
    [
      JSON.stringify({ type: "plan", at: "2026-05-11T05:40:02.977Z", planId: "one" }),
      JSON.stringify({ type: "apply", at: "2026-07-17T00:00:34.763Z", planId: "two" })
    ].join("\n") + "\n"
  );
  const archive = path.join(base, "cleanup-log-2025-12.jsonl.gz");
  await fs.writeFile(
    archive,
    gzipSync(`${JSON.stringify({ type: "plan", at: "2025-12-01T00:00:00Z", planId: "old" })}\n`)
  );

  const plan = await planCleanupLogRetention({
    cleanupLogFile,
    asOf: new Date("2026-07-18T00:00:00Z"),
    retentionDays: 180
  });

  assert.deepEqual(plan.currentLog.completedMonthRotationPlans.map((row) => row.month), ["2026-05"]);
  assert.equal(plan.archives.length, 1);
  assert.equal(plan.archives[0].path, archive);
  assert.equal(plan.archives[0].action, "would-delete-after-180-days");
  assert.equal(plan.archives[0].validGzipJsonl, true);
});

test("cleanup JSONL archives reject filename-content month mismatch and malformed gzip or JSONL", async (t) => {
  const { base, cleanupLogFile } = await fixtureRoot(t);
  const archive = path.join(base, "cleanup-log-2025-01.jsonl.gz");
  const options = {
    cleanupLogFile,
    asOf: new Date("2026-07-18T00:00:00Z"),
    retentionDays: 180
  };

  await fs.writeFile(
    archive,
    gzipSync(`${JSON.stringify({ type: "plan", at: "2026-07-17T00:00:00Z", planId: "mismatch" })}\n`)
  );
  await assert.rejects(planCleanupLogRetention(options), /archive.*month|month.*archive/i);

  await fs.writeFile(archive, "not-gzip");
  await assert.rejects(planCleanupLogRetention(options), /archive validation failed/i);

  await fs.writeFile(archive, gzipSync("{malformed-jsonl\n"));
  await assert.rejects(planCleanupLogRetention(options), /archive validation failed.*invalid JSONL/i);
});

test("noncanonical cleanup JSONL row timestamps block archive retention with no candidates", async (t) => {
  const { base, artifactRoot, stateFile, cleanupLogFile } = await fixtureRoot(t);
  const archive = path.join(base, "cleanup-log-2025-01.jsonl.gz");

  for (const at of ["0", "2025-01", "01/02/2025"]) {
    await fs.writeFile(
      archive,
      gzipSync(`${JSON.stringify({ type: "plan", at, planId: "malformed-time" })}\n`)
    );
    const manifest = await buildCleanupArtifactRetentionManifest({
      artifactRoot,
      stateFile,
      cleanupLogFile,
      asOf: new Date("2026-07-18T00:00:00Z"),
      maxAgeDays: 30,
      newestMinimum: 0,
      maxReclaimBytes: 1024 ** 3,
      cleanupLogRetentionDays: 180,
      activeReferencedDirs: []
    });
    const label = `row.at=${JSON.stringify(at)}`;

    assert.deepEqual(manifest.cleanupLog.archives, [], label);
    assert.deepEqual(manifest.candidates, [], label);
    assert.ok(manifest.blockingFindings.some((row) => (
      row.reason.includes("archive validation failed") && row.reason.includes("invalid cleanup log")
    )), label);
    assert.equal(manifest.budget.blocked, true, label);
    assert.deepEqual(manifest.budget.approvedObjectIds, [], label);
  }
});

test("generated restore script publishes and clears an active restore reference", () => {
  const source = cleanupRestoreScript("/tmp/artifact/manifest.jsonl");
  assert.match(source, /\.restore-active\.json/);
  assert.match(source, /restore-complete\.json/);
  assert.match(source, /manifestSha256/);
  assert.match(source, /hashlib\.sha256/);
  assert.match(source, /os\.O_EXCL/);
  assert.match(source, /finally:/);
  assert.match(source, /active_ref\.unlink/);
});

test("generated restore script is valid Python", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "codex-restore-script-"));
  const script = path.join(base, "restore-cleanup.py");
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.writeFile(script, cleanupRestoreScript("/tmp/artifact/manifest.jsonl"));
  await execFile("python3", ["-m", "py_compile", script]);
});

test("generated restore script executes and hashes one pinned manifest byte buffer", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "codex-restore-pinned-bytes-"));
  const artifact = path.join(base, "artifact");
  const manifest = path.join(artifact, "manifest.jsonl");
  const script = path.join(artifact, "restore-cleanup.py");
  const source = path.join(base, "source");
  const destination = path.join(base, "restored-source");
  await fs.mkdir(artifact, { recursive: true });
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "sentinel.txt"), "original\n");
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const originalBytes = [
    JSON.stringify({ type: "quarantine", to: source, from: destination }),
    ...Array.from({ length: 50_000 }, (_, index) => JSON.stringify({
      type: "delete",
      backup: path.join(base, `missing-${index}`),
      from: path.join(base, `unused-${index}`)
    }))
  ].join("\n") + "\n";
  const replacementBytes = `${JSON.stringify({ type: "delete", backup: "/replacement", from: "/not-executed" })}\n`;
  await fs.writeFile(manifest, originalBytes);
  await fs.writeFile(script, cleanupRestoreScript(manifest));

  const child = spawn("python3", [script], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const completed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({ code, stderr });
    });
  });

  await waitForPath(destination);
  await fs.writeFile(manifest, replacementBytes);
  const result = await completed;

  assert.notEqual(result.code, 0, result.stderr);
  assert.equal(await fs.readFile(path.join(destination, "sentinel.txt"), "utf8"), "original\n");
  await assert.rejects(fs.lstat(path.join(artifact, "restore-complete.json")), { code: "ENOENT" });
  await assert.rejects(fs.lstat(path.join(artifact, ".restore-active.json")), { code: "ENOENT" });

  const stableArtifact = path.join(base, "stable-artifact");
  const stableManifest = path.join(stableArtifact, "manifest.jsonl");
  const stableScript = path.join(stableArtifact, "restore-cleanup.py");
  const stableBackup = path.join(base, "stable-backup.txt");
  const stableDestination = path.join(base, "stable-destination.txt");
  const stableBytes = `${JSON.stringify({ type: "delete", backup: stableBackup, from: stableDestination })}\n`;
  await fs.mkdir(stableArtifact);
  await fs.writeFile(stableBackup, "restored once\n");
  await fs.writeFile(stableManifest, stableBytes);
  await fs.writeFile(stableScript, cleanupRestoreScript(stableManifest));
  await execFile("python3", [stableScript]);
  const stableMarker = JSON.parse(
    await fs.readFile(path.join(stableArtifact, "restore-complete.json"), "utf8")
  );
  assert.equal(
    stableMarker.manifestSha256,
    crypto.createHash("sha256").update(stableBytes).digest("hex")
  );
  assert.equal(await fs.readFile(stableDestination, "utf8"), "restored once\n");

  await fs.writeFile(stableDestination, "changed after restore\n");
  await assert.rejects(execFile("python3", [stableScript]), /restore already completed/);
  assert.equal(await fs.readFile(stableDestination, "utf8"), "changed after restore\n");
  await assert.rejects(fs.lstat(path.join(stableArtifact, ".restore-active.json")), { code: "ENOENT" });
});
