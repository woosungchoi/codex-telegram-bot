import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildCleanupArtifactPaths,
  cleanupRestoreScript,
  copyCleanupBackup,
  createCleanupArtifact,
  finalizeCleanupArtifact
} from "../src/maintenance/cleanup.js";

function mode(stat) {
  return stat.mode & 0o777;
}

test("cleanup artifact paths sanitize plan id", () => {
  const artifact = buildCleanupArtifactPaths({
    cleanupArtifactDir: "/artifacts",
    dateKey: "20260603",
    planId: "../bad plan",
    action: "both"
  });
  assert.equal(artifact.dir, "/artifacts/20260603-___bad_plan-both");
  assert.equal(artifact.manifest, "/artifacts/20260603-___bad_plan-both/manifest.jsonl");
});

test("cleanup artifact writes plan, manifest, result, and restore script", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-telegram-cleanup-"));
  const plan = { id: "plan-1", quarantineCandidates: [], deleteCandidates: [] };
  const artifact = await createCleanupArtifact({
    plan,
    action: "delete",
    cleanupArtifactDir: root,
    dateKey: "20260603"
  });

  await finalizeCleanupArtifact(artifact, [{ type: "delete", from: "/old", backup: "/backup" }], { deleted: 1 });

  assert.equal(JSON.parse(await fs.readFile(path.join(artifact.dir, "plan.json"), "utf8")).id, "plan-1");
  assert.match(await fs.readFile(artifact.restoreScript, "utf8"), /manifest = Path/);
  assert.match(await fs.readFile(artifact.manifest, "utf8"), /"type":"delete"/);
  assert.equal(JSON.parse(await fs.readFile(path.join(artifact.dir, "result.json"), "utf8")).deleted, 1);
  assert.equal(mode(await fs.stat(artifact.dir)), 0o700);
  assert.equal(mode(await fs.stat(artifact.deleteBackupDir)), 0o700);
  for (const file of ["plan.json", "manifest.jsonl", "result.json", "restore-cleanup.py"]) {
    assert.equal(mode(await fs.stat(path.join(artifact.dir, file))), 0o600);
  }
});

test("cleanup backup copies are hardened without following symlinks", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-telegram-cleanup-copy-"));
  const source = path.join(root, "source");
  const destination = path.join(root, "backup", "source");
  const outside = path.join(root, "outside.txt");
  await fs.mkdir(source, { mode: 0o775 });
  await fs.chmod(source, 0o775);
  await fs.writeFile(path.join(source, "record.json"), "{}\n", { mode: 0o664 });
  await fs.chmod(path.join(source, "record.json"), 0o664);
  await fs.writeFile(outside, "outside\n", { mode: 0o664 });
  await fs.chmod(outside, 0o664);
  await fs.symlink(outside, path.join(source, "outside-link"));

  await copyCleanupBackup(source, destination);

  assert.equal(mode(await fs.stat(destination)), 0o700);
  assert.equal(mode(await fs.stat(path.join(destination, "record.json"))), 0o600);
  assert.equal(mode(await fs.stat(outside)), 0o664);
  assert.equal((await fs.lstat(path.join(destination, "outside-link"))).isSymbolicLink(), true);
});

test("cleanup restore script points at manifest path", () => {
  const source = cleanupRestoreScript("/tmp/manifest.jsonl");
  assert.match(source, /Path\("\/tmp\/manifest\.jsonl"\)/);
  assert.match(source, /\.restore-active\.json/);
  assert.match(source, /restore-complete\.json/);
  assert.match(source, /manifestSha256/);
  assert.match(source, /finally:/);
});
