import { createHash } from "node:crypto";
import { anchoredCreate } from "../fs/anchored.js";
import { signControlRecord, controlKey, DEFAULT_CONTROL_DIR } from "./control_receipt.js";
import fs from "node:fs/promises";
import path from "node:path";
import {
  ensurePrivateDirectory,
  hardenPrivateTree
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

export async function createCleanupArtifact({ plan, action, cleanupArtifactDir, dateKey, controlDirectory = DEFAULT_CONTROL_DIR, restoreProgram = "/usr/local/lib/codex-telegram-bot/restore-cleanup.py" }) {
  const artifact = buildCleanupArtifactPaths({
    cleanupArtifactDir,
    dateKey,
    planId: plan.id,
    action
  });
  await controlKey(controlDirectory);
  artifact.controlDirectory = controlDirectory;
  artifact.id = `cleanup-${plan.id}`;
  artifact.operator = plan.operator || { source: plan.source };
  await anchoredCreate(artifact.dir, "plan.json", `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  artifact.restoreScript = `${shellQuote(restoreProgram)} --control-dir ${shellQuote(controlDirectory)} --id ${shellQuote(artifact.id)}`;
  return artifact;
}

export async function finalizeCleanupArtifact(artifact, operations, result) {
  const lines = operations.map((operation) => JSON.stringify(operation));
  const manifest = `${lines.join("\n")}${lines.length ? "\n" : ""}`;
  await anchoredCreate(artifact.dir, "manifest.jsonl", manifest);
  await signControlRecord(artifact.controlDirectory, artifact.id, { kind: "cleanup-restore-v1", id: artifact.id, operator: artifact.operator, manifest: artifact.manifest, manifestSha256: createHash("sha256").update(manifest).digest("hex"), operations });
  await anchoredCreate(artifact.dir, "result.json", `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

export async function copyCleanupBackup(source, destination) {
  await ensurePrivateDirectory(path.dirname(destination));
  await fs.cp(source, destination, { recursive: true, force: true });
  const unexpected = await hardenPrivateTree(destination);
  if (unexpected.length > 0) {
    throw new Error(`Unsupported file type in cleanup backup: ${unexpected[0].type}`);
  }
}

// Retained only for callers displaying old artifacts. New artifacts contain no executable code.
export function cleanupRestoreScript() { throw new Error("Generated restore scripts are disabled; use the installed trusted restore command."); }

function shellQuote(value) { return "'" + String(value).replaceAll("'", "'\"'\"'") + "'"; }
