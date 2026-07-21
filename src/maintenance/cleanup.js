import fs from "node:fs/promises";
import path from "node:path";
import {
  ensurePrivateDirectory,
  hardenPrivateTree,
  writePrivateFile
} from "../fs/private.js";

export function buildCleanupArtifactPaths({ cleanupArtifactDir, dateKey, planId, action }) {
  const safePlanId = String(planId || "plan").replace(/[^a-zA-Z0-9_-]/g, "_");
  const dir = path.join(cleanupArtifactDir, `${dateKey}-${safePlanId}-${action}`);
  return {
    dir,
    deleteBackupDir: path.join(dir, "delete-backup"),
    manifest: path.join(dir, "manifest.jsonl"),
    restoreScript: path.join(dir, "restore-cleanup.py")
  };
}

export async function createCleanupArtifact({ plan, action, cleanupArtifactDir, dateKey }) {
  const artifact = buildCleanupArtifactPaths({
    cleanupArtifactDir,
    dateKey,
    planId: plan.id,
    action
  });
  await ensurePrivateDirectory(artifact.dir);
  await ensurePrivateDirectory(artifact.deleteBackupDir);
  await writePrivateFile(path.join(artifact.dir, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  await writePrivateFile(artifact.restoreScript, cleanupRestoreScript(artifact.manifest), "utf8");
  return artifact;
}

export async function finalizeCleanupArtifact(artifact, operations, result) {
  const lines = operations.map((operation) => JSON.stringify(operation));
  await writePrivateFile(artifact.manifest, `${lines.join("\n")}${lines.length ? "\n" : ""}`, "utf8");
  await writePrivateFile(path.join(artifact.dir, "result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

export async function copyCleanupBackup(source, destination) {
  await ensurePrivateDirectory(path.dirname(destination));
  await fs.cp(source, destination, { recursive: true, force: true });
  const unexpected = await hardenPrivateTree(destination);
  if (unexpected.length > 0) {
    throw new Error(`Unsupported file type in cleanup backup: ${unexpected[0].type}`);
  }
}

export function cleanupRestoreScript(manifestPath) {
  return `#!/usr/bin/env python3
import hashlib
import json
import os
import shutil
import stat
from datetime import datetime, timezone
from pathlib import Path

manifest = Path(${JSON.stringify(manifestPath)})
active_ref = manifest.parent / ".restore-active.json"
complete_ref = manifest.parent / "restore-complete.json"
exclusive_write_flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
fd = os.open(active_ref, exclusive_write_flags, 0o600)
with os.fdopen(fd, "w", encoding="utf-8") as handle:
    json.dump({
        "schema": "codex-cleanup-restore-active/v1",
        "pid": os.getpid(),
        "startedAt": datetime.now(timezone.utc).isoformat(),
    }, handle, sort_keys=True)
    handle.write("\\n")
try:
    try:
        complete_ref.lstat()
    except FileNotFoundError:
        pass
    else:
        raise RuntimeError("restore already completed; refusing to run again")
    lexical_before = manifest.lstat()
    if stat.S_ISLNK(lexical_before.st_mode) or not stat.S_ISREG(lexical_before.st_mode):
        raise RuntimeError("manifest must be a regular non-symlink file")
    if lexical_before.st_nlink != 1:
        raise RuntimeError("manifest hard-link count must be exactly one")
    manifest_fd = os.open(manifest, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    with os.fdopen(manifest_fd, "rb", closefd=True) as manifest_handle:
        opened_before = os.fstat(manifest_handle.fileno())
        identity_before = (
            opened_before.st_dev, opened_before.st_ino, opened_before.st_size,
            opened_before.st_mtime_ns, opened_before.st_ctime_ns, opened_before.st_nlink,
            opened_before.st_uid, opened_before.st_gid, stat.S_IMODE(opened_before.st_mode),
        )
        lexical_identity = (
            lexical_before.st_dev, lexical_before.st_ino, lexical_before.st_size,
            lexical_before.st_mtime_ns, lexical_before.st_ctime_ns, lexical_before.st_nlink,
            lexical_before.st_uid, lexical_before.st_gid, stat.S_IMODE(lexical_before.st_mode),
        )
        if lexical_identity != identity_before:
            raise RuntimeError("manifest identity changed before restore")
        manifest_bytes = manifest_handle.read()
        opened_after_read = os.fstat(manifest_handle.fileno())
        if (
            opened_after_read.st_dev, opened_after_read.st_ino, opened_after_read.st_size,
            opened_after_read.st_mtime_ns, opened_after_read.st_ctime_ns, opened_after_read.st_nlink,
            opened_after_read.st_uid, opened_after_read.st_gid, stat.S_IMODE(opened_after_read.st_mode),
        ) != identity_before:
            raise RuntimeError("manifest identity changed while reading")
        for line in manifest_bytes.decode("utf-8", errors="strict").splitlines():
            rec = json.loads(line)
            if rec.get("type") == "quarantine":
                src = Path(rec["to"])
                dest = Path(rec["from"])
                if src.exists():
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    shutil.move(str(src), str(dest))
            elif rec.get("type") == "delete":
                src = Path(rec["backup"])
                dest = Path(rec["from"])
                if src.exists():
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(src, dest)
                meta = Path(str(src) + ".cleanup.json")
                if meta.exists():
                    shutil.copy2(meta, Path(str(dest) + ".cleanup.json"))
        opened_after = os.fstat(manifest_handle.fileno())
        lexical_after = manifest.lstat()
        opened_after_identity = (
            opened_after.st_dev, opened_after.st_ino, opened_after.st_size,
            opened_after.st_mtime_ns, opened_after.st_ctime_ns, opened_after.st_nlink,
            opened_after.st_uid, opened_after.st_gid, stat.S_IMODE(opened_after.st_mode),
        )
        lexical_after_identity = (
            lexical_after.st_dev, lexical_after.st_ino, lexical_after.st_size,
            lexical_after.st_mtime_ns, lexical_after.st_ctime_ns, lexical_after.st_nlink,
            lexical_after.st_uid, lexical_after.st_gid, stat.S_IMODE(lexical_after.st_mode),
        )
        if opened_after_identity != identity_before or lexical_after_identity != identity_before:
            raise RuntimeError("manifest identity changed during restore")
        complete_fd = os.open(complete_ref, exclusive_write_flags, 0o600)
        with os.fdopen(complete_fd, "w", encoding="utf-8") as handle:
            json.dump({
                "schema": "codex-cleanup-restore-complete/v1",
                "status": "complete",
                "completedAt": datetime.now(timezone.utc).isoformat(),
                "manifestSha256": hashlib.sha256(manifest_bytes).hexdigest(),
            }, handle, sort_keys=True)
            handle.write("\\n")
finally:
    active_ref.unlink(missing_ok=True)
`;
}
