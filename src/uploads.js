import { anchoredUnlink, fileIdentity } from "./fs/anchored.js";
import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

export function selectUploadCleanupCandidates(files, options = {}) {
  const nowMs = (options.now ?? new Date()).getTime();
  const retentionDays = Math.max(0, Number(options.retentionDays ?? 0));
  const maxBytes = Math.max(0, Number(options.maxBytes ?? 0));
  const cutoffMs = nowMs - retentionDays * 86_400_000;
  const totalBytes = files.reduce((sum, file) => sum + Number(file.bytes ?? 0), 0);
  const candidatesByPath = new Map();

  for (const file of files) {
    if (retentionDays > 0 && Number(file.mtimeMs ?? 0) < cutoffMs) candidatesByPath.set(file.path, file);
  }

  if (maxBytes > 0 && totalBytes > maxBytes) {
    let projectedBytes = totalBytes - [...candidatesByPath.values()].reduce((sum, file) => sum + Number(file.bytes ?? 0), 0);
    const oldestFirst = [...files]
      .filter((file) => !candidatesByPath.has(file.path))
      .sort((left, right) => Number(left.mtimeMs ?? 0) - Number(right.mtimeMs ?? 0));
    for (const file of oldestFirst) {
      if (projectedBytes <= maxBytes) break;
      candidatesByPath.set(file.path, file);
      projectedBytes -= Number(file.bytes ?? 0);
    }
  }

  const candidates = [...candidatesByPath.values()].sort((left, right) => Number(left.mtimeMs ?? 0) - Number(right.mtimeMs ?? 0));
  const preserved = files.filter((file) => !candidatesByPath.has(file.path));
  return {
    candidates,
    preserved,
    totalBytes,
    candidateBytes: candidates.reduce((sum, file) => sum + Number(file.bytes ?? 0), 0),
    maxBytes,
    retentionDays
  };
}

export function buildUploadCleanupPlan(files, options = {}) {
  const selected = selectUploadCleanupCandidates(files, options);
  return {
    ...selected,
    dryRun: options.dryRun !== false,
    generatedAt: (options.now ?? new Date()).toISOString()
  };
}

export function createUploadCleanupPlanId(now = new Date(), suffix = randomBytes(4).toString("hex")) {
  return `${now.toISOString().replace(/[-:.]/g, "").replace("Z", "Z")}-${suffix}`;
}

export function createUploadCleanupPlanRecord(plan, options = {}) {
  const now = options.now ?? new Date();
  const ttlMs = Math.max(0, Number(options.ttlMs ?? 86_400_000));
  const id = options.id ?? createUploadCleanupPlanId(now);
  return {
    id,
    plan,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString()
  };
}

export function confirmUploadCleanupPlan(record, options = {}) {
  if (!record) return { ok: false, reason: "missing_plan" };
  const nowMs = (options.now ?? new Date()).getTime();
  const expiresAt = Date.parse(record.expiresAt);
  if (!record.plan || Number.isNaN(expiresAt)) return { ok: false, reason: "missing_plan" };
  if (expiresAt < nowMs) return { ok: false, reason: "expired_plan" };
  return { ok: true, plan: record.plan };
}

export function createUploadCleanupPlanLogEntry(plan, options = {}) {
  return {
    type: "upload_cleanup_plan",
    planId: options.planId,
    dryRun: true,
    candidates: plan.candidates.length,
    candidateBytes: plan.candidateBytes,
    totalBytes: plan.totalBytes,
    at: options.at ?? plan.generatedAt
  };
}

export function createUploadCleanupResultLogEntry(planId, plan, result, options = {}) {
  return {
    type: "upload_cleanup",
    planId,
    result,
    candidates: plan.candidates.length,
    candidateBytes: plan.candidateBytes,
    at: options.at ?? new Date().toISOString()
  };
}

export async function buildUploadCleanupPlanFromDisk(uploadDir, options = {}) {
  const files = await listUploadFiles(uploadDir);
  return buildUploadCleanupPlan(files, options);
}

export async function deleteUploadCandidates(candidates, options = {}) {
  const dryRun = options.dryRun !== false;
  const removeFile = options.removeFile;
  const rootDir = options.rootDir ? path.resolve(options.rootDir) : null;
  const result = { deleted: 0, skipped: 0, errors: [] };
  for (const candidate of candidates) {
    const candidatePath = path.resolve(candidate.path);
    if (rootDir && !isPathInside(candidatePath, rootDir)) {
      result.skipped += 1;
      result.errors.push({ path: candidate.path, message: "upload cleanup candidate is outside upload directory" });
      continue;
    }
    if (dryRun) {
      result.skipped += 1;
      continue;
    }
    try {
      if (removeFile) await removeFile(candidatePath);
      else {
        if (!rootDir) throw new Error("Upload cleanup requires an anchored root.");
        await anchoredUnlink(rootDir, candidatePath, candidate.identity);
      }
      result.deleted += 1;
    } catch (error) {
      result.errors.push({ path: candidate.path, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}

export function shouldRunUploadCleanup({ cleanupEnabled, uploadCleanupEnabled }) {
  return cleanupEnabled === true && uploadCleanupEnabled === true;
}

export async function listUploadFiles(uploadDir) {
  try {
    return await listFilesRecursive(uploadDir);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function isPathInside(candidatePath, rootDir) {
  const relative = path.relative(rootDir, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function listFilesRecursive(root) {
  const entries = [];
  const dirents = await fs.readdir(root, { withFileTypes: true });
  for (const dirent of dirents) {
    const entryPath = path.join(root, dirent.name);
    if (dirent.isDirectory()) {
      entries.push(...await listFilesRecursive(entryPath));
    } else if (dirent.isFile()) {
      const stat = await fs.lstat(entryPath);
      if (!stat.isFile()) continue;
      entries.push({
        path: entryPath,
        identity: fileIdentity(stat),
        bytes: stat.size,
        mtimeMs: stat.mtimeMs,
        modifiedAt: stat.mtime.toISOString()
      });
    }
  }
  return entries;
}
