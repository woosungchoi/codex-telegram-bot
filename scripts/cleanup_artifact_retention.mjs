#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { writePrivateFileAtomic } from "../src/fs/private.js";

const DAY_MS = 86_400_000;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_ARTIFACT_ROOT = path.join(APP_ROOT, "state", "cleanup-artifacts");
const DEFAULT_STATE_FILE = path.join(APP_ROOT, "state", "threads.json");
const DEFAULT_CLEANUP_LOG = path.join(APP_ROOT, "state", "cleanup-log.jsonl");
const DEFAULT_OUTPUT = path.join(APP_ROOT, "state", "retention-audit", "cleanup-artifacts-latest.json");
const NAME_RE = /^(\d{4}-\d{2}-\d{2})-(.+)-(quarantine|delete|both|ignore)$/;
const LOG_ARCHIVE_RE = /^cleanup-log-(\d{4}-\d{2})\.jsonl\.gz$/;
const PRODUCER_TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?(Z|([+-])(\d{2}):(\d{2}))$/;

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function withIntegrity(payload) {
  const payloadSha256 = crypto.createHash("sha256").update(canonicalJson(payload)).digest("hex");
  return { ...payload, integrity: { algorithm: "sha256", payloadSha256 } };
}

function validDateKey(dateKey) {
  const parsed = new Date(`${dateKey}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === dateKey;
}

function validMonthKey(month) {
  const parsed = new Date(`${month}-01T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 7) === month;
}

export function parseCleanupArtifactName(name) {
  if (!name || path.basename(name) !== name || name === "." || name === "..") {
    throw new Error(`cleanup artifact name is not a direct child: ${name}`);
  }
  const match = NAME_RE.exec(name);
  if (!match || !validDateKey(match[1]) || !match[2]) {
    throw new Error(`unsupported cleanup artifact directory name: ${name}`);
  }
  return { dateKey: match[1], planId: match[2], action: match[3] };
}

function isWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function readJsonObject(filePath) {
  const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`JSON root must be an object: ${filePath}`);
  }
  return parsed;
}

async function inspectTree(root, { maxObjects = 100_000 } = {}) {
  const lexical = path.resolve(root);
  const rootStat = await fs.lstat(lexical);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("top-level artifact must be a non-symlink directory");
  }
  const real = await fs.realpath(lexical);
  if (real !== lexical) throw new Error("top-level artifact realpath differs from lexical path");
  const device = rootStat.dev;
  let objectCount = 1;
  let sizeBytes = 0;
  let maxMtimeMs = rootStat.mtimeMs;
  const stack = [lexical];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const child = path.join(current, entry.name);
      const childStat = await fs.lstat(child);
      objectCount += 1;
      if (objectCount > maxObjects) throw new Error(`artifact object budget exceeded: ${objectCount}>${maxObjects}`);
      if (childStat.dev !== device) throw new Error(`nested filesystem crossing rejected: ${child}`);
      if (childStat.isSymbolicLink()) throw new Error(`nested symlink rejected: ${child}`);
      if (childStat.isDirectory()) stack.push(child);
      else if (childStat.isFile()) sizeBytes += childStat.size;
      else throw new Error(`nested special file rejected: ${child}`);
      maxMtimeMs = Math.max(maxMtimeMs, childStat.mtimeMs);
    }
  }
  return {
    path: lexical,
    realpath: real,
    device,
    inode: rootStat.ino,
    uid: rootStat.uid,
    gid: rootStat.gid,
    mode: (rootStat.mode & 0o777).toString(8).padStart(4, "0"),
    objectCount,
    sizeBytes,
    maxMtimeMs,
    maxMtime: new Date(maxMtimeMs).toISOString()
  };
}

function parseTimestamp(value, field) {
  const match = typeof value === "string" ? PRODUCER_TIMESTAMP_RE.exec(value) : null;
  if (!match) throw new Error(`invalid ${field} timestamp`);
  const [, year, month, day, hour, minute, second, millisecond = "000", zone, sign, offsetHour = "00", offsetMinute = "00"] = match;
  const parts = [year, month, day, hour, minute, second, millisecond, offsetHour, offsetMinute].map(Number);
  const [yearNumber, monthNumber, dayNumber, hourNumber, minuteNumber, secondNumber, millisecondNumber, offsetHourNumber, offsetMinuteNumber] = parts;
  if (monthNumber < 1 || monthNumber > 12 || dayNumber < 1 || dayNumber > 31
      || hourNumber > 23 || minuteNumber > 59 || secondNumber > 59
      || offsetHourNumber > 23 || offsetMinuteNumber > 59) {
    throw new Error(`invalid ${field} timestamp`);
  }
  const wallClock = new Date(0);
  wallClock.setUTCFullYear(yearNumber, monthNumber - 1, dayNumber);
  wallClock.setUTCHours(hourNumber, minuteNumber, secondNumber, millisecondNumber);
  if (wallClock.getUTCFullYear() !== yearNumber || wallClock.getUTCMonth() !== monthNumber - 1
      || wallClock.getUTCDate() !== dayNumber || wallClock.getUTCHours() !== hourNumber
      || wallClock.getUTCMinutes() !== minuteNumber || wallClock.getUTCSeconds() !== secondNumber
      || wallClock.getUTCMilliseconds() !== millisecondNumber) {
    throw new Error(`invalid ${field} timestamp`);
  }
  const offsetMinutes = zone === "Z" ? 0 : (sign === "+" ? 1 : -1) * (offsetHourNumber * 60 + offsetMinuteNumber);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed !== wallClock.getTime() - offsetMinutes * 60_000) {
    throw new Error(`invalid ${field} timestamp`);
  }
  return parsed;
}

function activeApprovalPlanIds(state, asOfMs) {
  const plans = state?.cleanup?.plans;
  if (plans === undefined) return new Set();
  if (!plans || typeof plans !== "object" || Array.isArray(plans)) {
    throw new Error("invalid cleanup.plans: expected an object");
  }
  const active = new Set();
  for (const [planId, value] of Object.entries(plans)) {
    if (!planId || !value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`invalid cleanup.plans entry: ${planId || "<empty>"}`);
    }
    const expiresAt = parseTimestamp(value.expiresAt, `cleanup.plans expiresAt: ${planId}`);
    if (expiresAt > asOfMs) active.add(planId);
  }
  return active;
}

function configuredRestoreReferences(state, artifactRoot) {
  const root = path.resolve(artifactRoot);
  const references = new Set();
  const addReference = (item, field) => {
    let value;
    if (typeof item === "string") value = item;
    else if (item && typeof item === "object" && !Array.isArray(item)) value = item.artifactDir;
    if (typeof value !== "string" || !value) {
      throw new Error(`invalid configured restore reference: ${field}`);
    }
    if (!path.isAbsolute(value)) {
      throw new Error(`configured restore reference must be absolute: ${field}`);
    }
    const resolved = path.resolve(value);
    if (resolved === root || !isWithin(resolved, root)) {
      throw new Error(`configured restore reference escaped artifact root: ${field}`);
    }
    const topLevelName = path.relative(root, resolved).split(path.sep)[0];
    if (!topLevelName) throw new Error(`invalid configured restore reference: ${field}`);
    references.add(path.join(root, topLevelName));
  };
  for (const [field, source] of [
    ["cleanup.restoreRefs", state?.cleanup?.restoreRefs],
    ["maintenance.restoreRefs", state?.maintenance?.restoreRefs]
  ]) {
    if (source === undefined) continue;
    if (Array.isArray(source)) {
      for (const [index, item] of source.entries()) addReference(item, `${field}[${index}]`);
    } else if (source && typeof source === "object") {
      for (const [key, item] of Object.entries(source)) {
        addReference(item, `${field}.${key}`);
      }
    } else throw new Error(`invalid configured restore reference collection: ${field}`);
  }
  return references;
}

async function collectProcessReferences(artifactRoot) {
  const references = new Set();
  const errors = [];
  const root = path.resolve(artifactRoot);
  let processEntries;
  try {
    processEntries = await fs.readdir("/proc", { withFileTypes: true });
  } catch (error) {
    return { references, errors: [`cannot enumerate /proc: ${error.code || error.name}`] };
  }
  for (const entry of processEntries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const processRoot = path.join("/proc", entry.name);
    let owner;
    try {
      owner = await fs.stat(processRoot);
    } catch (error) {
      if (error.code !== "ENOENT") errors.push(`cannot stat ${processRoot}: ${error.code || error.name}`);
      continue;
    }
    if (owner.uid !== process.getuid()) continue;
    const links = [path.join(processRoot, "cwd")];
    try {
      const fds = await fs.readdir(path.join(processRoot, "fd"));
      links.push(...fds.map((fd) => path.join(processRoot, "fd", fd)));
    } catch (error) {
      if (error.code !== "ENOENT") errors.push(`cannot inspect same-user process ${entry.name} fds: ${error.code || error.name}`);
    }
    for (const link of links) {
      try {
        const target = path.resolve((await fs.readlink(link)).replace(/ \(deleted\)$/, ""));
        if (!isWithin(target, root) || target === root) continue;
        const relative = path.relative(root, target).split(path.sep)[0];
        if (relative) references.add(path.join(root, relative));
      } catch (error) {
        if (!["ENOENT", "EINVAL"].includes(error.code)) {
          errors.push(`cannot inspect same-user process reference: ${error.code || error.name}`);
        }
      }
    }
  }
  return { references, errors: [...new Set(errors)] };
}

async function inspectArtifactDirectory(dir, parsed, asOfMs) {
  const tree = await inspectTree(dir);
  const required = ["plan.json", "manifest.jsonl", "result.json", "restore-cleanup.py"];
  for (const name of required) {
    const fileStat = await fs.lstat(path.join(dir, name));
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) throw new Error(`required regular file is absent: ${name}`);
  }
  const plan = await readJsonObject(path.join(dir, "plan.json"));
  const result = await readJsonObject(path.join(dir, "result.json"));
  if (plan.id !== parsed.planId) throw new Error("directory plan ID differs from plan.json");
  const createdAtMs = parseTimestamp(plan.createdAt, "createdAt");
  const expiresAtMs = parseTimestamp(plan.expiresAt, "expiresAt");
  const errors = result.errors;
  if (errors !== undefined && (!Array.isArray(errors) || errors.length > 0)) {
    throw new Error("cleanup result is not a successful terminal result");
  }
  let restoreComplete = false;
  try {
    const marker = await readJsonObject(path.join(dir, "restore-complete.json"));
    const manifestSha256 = crypto
      .createHash("sha256")
      .update(await fs.readFile(path.join(dir, "manifest.jsonl")))
      .digest("hex");
    restoreComplete = marker.schema === "codex-cleanup-restore-complete/v1"
      && marker.status === "complete"
      && marker.manifestSha256 === manifestSha256;
    if (!restoreComplete) throw new Error("restore completion marker schema/status/hash is invalid");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return {
    ...tree,
    name: path.basename(dir),
    planId: parsed.planId,
    action: parsed.action,
    dateKey: parsed.dateKey,
    createdAt: new Date(createdAtMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    terminalStates: {
      closed: true,
      expired: expiresAtMs <= asOfMs,
      restoreComplete
    }
  };
}

function monthEndUtc(month) {
  const [year, monthNumber] = month.split("-").map(Number);
  return Date.UTC(year, monthNumber, 1);
}

function parseJsonl(text, source) {
  const rows = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      throw new Error(`invalid JSONL at ${source}:${index + 1}`);
    }
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error(`JSONL row must be an object at ${source}:${index + 1}`);
    }
    parseTimestamp(row.at, `cleanup log ${source}:${index + 1}`);
    rows.push(row);
  }
  return rows;
}

export async function planCleanupLogRetention({ cleanupLogFile, asOf, retentionDays }) {
  const current = path.resolve(cleanupLogFile);
  const currentStat = await fs.lstat(current);
  if (!currentStat.isFile() || currentStat.isSymbolicLink()) {
    throw new Error("cleanup log must be a regular non-symlink file");
  }
  const currentRows = parseJsonl(await fs.readFile(current, "utf8"), current);
  const currentMonth = asOf.toISOString().slice(0, 7);
  const completedMonths = [...new Set(currentRows.map((row) => new Date(row.at).toISOString().slice(0, 7)))]
    .filter((month) => month < currentMonth)
    .sort();
  const archives = [];
  const parent = path.dirname(current);
  for (const entry of await fs.readdir(parent, { withFileTypes: true })) {
    const match = LOG_ARCHIVE_RE.exec(entry.name);
    if (!match) continue;
    const archivePath = path.join(parent, entry.name);
    if (!validMonthKey(match[1]) || match[1] >= currentMonth) {
      throw new Error(`cleanup log archive month is invalid or incomplete: ${archivePath}`);
    }
    const archiveStat = await fs.lstat(archivePath);
    if (!archiveStat.isFile() || archiveStat.isSymbolicLink()) {
      throw new Error(`cleanup log archive is not a regular file: ${archivePath}`);
    }
    let rows;
    try {
      rows = parseJsonl(gunzipSync(await fs.readFile(archivePath)).toString("utf8"), archivePath);
    } catch (error) {
      throw new Error(`cleanup log archive validation failed: ${archivePath}: ${error.message}`);
    }
    if (rows.length === 0) throw new Error(`cleanup log archive contains no rows: ${archivePath}`);
    const rowTimestamps = rows.map((row) => new Date(row.at));
    if (rowTimestamps.some((row) => row.toISOString().slice(0, 7) !== match[1])) {
      throw new Error(`cleanup log archive row month differs from filename archive month: ${archivePath}`);
    }
    const firstRowMs = Math.min(...rowTimestamps.map((row) => row.getTime()));
    const lastRowMs = Math.max(...rowTimestamps.map((row) => row.getTime()));
    const retentionAnchorMs = Math.max(monthEndUtc(match[1]), lastRowMs);
    const ageMs = asOf.getTime() - retentionAnchorMs;
    archives.push({
      adapter: "codex-cleanup-log-archive",
      objectId: `codex-cleanup-log-archive:${archivePath}`,
      path: archivePath,
      month: match[1],
      sizeBytes: archiveStat.size,
      rowCount: rows.length,
      firstRowAt: new Date(firstRowMs).toISOString(),
      lastRowAt: new Date(lastRowMs).toISOString(),
      retentionAnchorAt: new Date(retentionAnchorMs).toISOString(),
      validGzipJsonl: true,
      action: ageMs >= retentionDays * DAY_MS ? `would-delete-after-${retentionDays}-days` : "preserve-within-retention"
    });
  }
  return {
    currentLog: {
      path: current,
      rowCount: currentRows.length,
      completedMonthRotationPlans: completedMonths.map((month) => ({
        month,
        action: "would-rotate-to-private-gzip-jsonl",
        executed: false
      }))
    },
    archives: archives.sort((first, second) => first.path.localeCompare(second.path))
  };
}

export async function buildCleanupArtifactRetentionManifest({
  artifactRoot,
  stateFile,
  cleanupLogFile,
  asOf,
  maxAgeDays,
  newestMinimum,
  maxReclaimBytes,
  cleanupLogRetentionDays,
  activeReferencedDirs = null
}) {
  const generatedAt = asOf.toISOString();
  const root = path.resolve(artifactRoot);
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || await fs.realpath(root) !== root) {
    throw new Error("cleanup artifact root must be a fixed non-symlink real directory");
  }
  let state = {};
  const blockingFindings = [];
  let activeStateBlocked = false;
  try {
    state = await readJsonObject(path.resolve(stateFile));
  } catch (error) {
    blockingFindings.push({ path: path.resolve(stateFile), reason: `state-file-error: ${error.message}` });
    activeStateBlocked = true;
  }
  let activeApprovalIds = new Set();
  let configuredRefs = new Set();
  try {
    activeApprovalIds = activeApprovalPlanIds(state, asOf.getTime());
  } catch (error) {
    blockingFindings.push({ path: path.resolve(stateFile), reason: error.message });
    activeStateBlocked = true;
  }
  try {
    configuredRefs = configuredRestoreReferences(state, root);
    for (const reference of configuredRefs) {
      blockingFindings.push({
        path: reference,
        reason: "active configured restore reference blocks the whole run"
      });
      activeStateBlocked = true;
    }
  } catch (error) {
    blockingFindings.push({ path: path.resolve(stateFile), reason: error.message });
    activeStateBlocked = true;
  }
  let processRefs;
  if (activeReferencedDirs === null) {
    const collected = await collectProcessReferences(root);
    processRefs = collected.references;
    blockingFindings.push(...collected.errors.map((reason) => ({ path: root, reason })));
  } else {
    processRefs = new Set(activeReferencedDirs.map((value) => path.resolve(value)));
  }

  const inspected = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const child = path.join(root, entry.name);
    try {
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("top-level entry is not a directory");
      const parsed = parseCleanupArtifactName(entry.name);
      inspected.push(await inspectArtifactDirectory(child, parsed, asOf.getTime()));
    } catch (error) {
      blockingFindings.push({ path: child, reason: error.message });
    }
  }
  inspected.sort((first, second) => second.maxMtimeMs - first.maxMtimeMs || first.path.localeCompare(second.path));
  const newest = new Set(inspected.slice(0, newestMinimum).map((row) => row.path));
  const cutoff = asOf.getTime() - maxAgeDays * DAY_MS;
  const candidates = [];
  const excluded = [];
  for (const row of inspected) {
    const base = {
      adapter: "codex-cleanup-artifact",
      objectId: `codex-cleanup-artifact:${row.path}`,
      path: row.path,
      planId: row.planId,
      cleanupAction: row.action,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      maxMtime: row.maxMtime,
      sizeBytes: row.sizeBytes,
      objectCount: row.objectCount,
      terminalStates: row.terminalStates
    };
    if (newest.has(row.path)) excluded.push({ ...base, reason: `newest-minimum-${newestMinimum}` });
    else if (activeApprovalIds.has(row.planId)) excluded.push({ ...base, reason: "active-approval-reference" });
    else if (configuredRefs.has(row.path)) excluded.push({ ...base, reason: "active-configured-restore-reference" });
    else if (processRefs.has(row.path)) excluded.push({ ...base, reason: "active-process-reference" });
    else {
      try {
        const marker = await fs.lstat(path.join(row.path, ".restore-active.json"));
        if (!marker.isFile() || marker.isSymbolicLink()) throw new Error("active restore marker type is invalid");
        excluded.push({ ...base, reason: "active-restore-marker" });
        continue;
      } catch (error) {
        if (error.code !== "ENOENT") {
          blockingFindings.push({ path: row.path, reason: error.message });
          continue;
        }
      }
      if (row.maxMtimeMs >= cutoff) excluded.push({ ...base, reason: "entire-directory-within-retention" });
      else if (!Object.values(row.terminalStates).some(Boolean)) {
        blockingFindings.push({ path: row.path, reason: "plan is not closed, expired, or restore-complete" });
      } else {
        candidates.push({ ...base, action: "would-delete-top-level-directory", reason: "closed-artifact-older-than-retention" });
      }
    }
  }

  let cleanupLog = { currentLog: null, archives: [] };
  try {
    cleanupLog = await planCleanupLogRetention({
      cleanupLogFile,
      asOf,
      retentionDays: cleanupLogRetentionDays
    });
  } catch (error) {
    blockingFindings.push({ path: path.resolve(cleanupLogFile), reason: error.message });
  }
  const logCandidates = cleanupLog.archives.filter((row) => row.action.startsWith("would-delete"));
  let allCandidates = [...candidates, ...logCandidates];
  if (activeStateBlocked) {
    excluded.push(...candidates.map((row) => ({
      ...row,
      action: undefined,
      reason: "active-state-validation-blocked-whole-run"
    })));
    allCandidates = [];
  }
  const candidateBytes = allCandidates.reduce((total, row) => total + Number(row.sizeBytes || 0), 0);
  const budgetReasons = [];
  if (candidateBytes > maxReclaimBytes) {
    budgetReasons.push(`candidate bytes ${candidateBytes} exceed maximum ${maxReclaimBytes}`);
  }
  if (blockingFindings.length > 0) budgetReasons.push(`${blockingFindings.length} safety finding(s) block the whole run`);
  const payload = {
    schema: "codex-cleanup-artifact-retention/v1",
    mode: "audit-only",
    generatedAt,
    policy: {
      maxAgeDays,
      newestMinimum,
      maxReclaimBytes,
      cleanupLogRetentionDays,
      topLevelOnly: true,
      allowedTerminalStates: ["closed", "expired", "restore-complete"]
    },
    artifactRoot: root,
    candidates: allCandidates.sort((first, second) => first.path.localeCompare(second.path)),
    excluded: excluded.sort((first, second) => first.path.localeCompare(second.path)),
    cleanupLog,
    blockingFindings: blockingFindings.sort((first, second) => first.path.localeCompare(second.path) || first.reason.localeCompare(second.reason)),
    budget: {
      maxReclaimBytes,
      candidateBytes,
      candidateCount: allCandidates.length,
      blocked: budgetReasons.length > 0,
      reasons: budgetReasons,
      approvedObjectIds: [],
      behavior: "abort-entire-run-never-truncate"
    },
    applyEligibility: {
      eligible: false,
      reason: "audit-only; no removal path or enabled timer is part of this card"
    },
    actualDeletedObjectIds: [],
    actualReclaimedBytes: 0,
    protectedBackup: "/home/openclaw/.codex/backups/codex-telegram-bot",
    protectedBackupDisposition: "preserve-until-supersession-and-restore-verification"
  };
  return withIntegrity(payload);
}

function parseArgs(argv) {
  const options = {
    artifactRoot: DEFAULT_ARTIFACT_ROOT,
    stateFile: DEFAULT_STATE_FILE,
    cleanupLogFile: DEFAULT_CLEANUP_LOG,
    output: DEFAULT_OUTPUT,
    asOf: new Date(),
    maxAgeDays: 30,
    newestMinimum: 7,
    maxReclaimBytes: 1024 ** 3,
    cleanupLogRetentionDays: 180
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${flag}`);
    index += 1;
    if (flag === "--artifact-root") options.artifactRoot = value;
    else if (flag === "--state-file") options.stateFile = value;
    else if (flag === "--cleanup-log") options.cleanupLogFile = value;
    else if (flag === "--output") options.output = value;
    else if (flag === "--as-of") options.asOf = new Date(parseTimestamp(value, "--as-of"));
    else throw new Error(`unsupported argument: ${flag}`);
  }
  if (Number.isNaN(options.asOf.getTime())) throw new Error("--as-of must be an ISO timestamp");
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifest = await buildCleanupArtifactRetentionManifest(options);
  await writePrivateFileAtomic(path.resolve(options.output), `${canonicalJson(manifest)}\n`);
  console.log(JSON.stringify({
    schema: "codex-cleanup-artifact-retention-summary/v1",
    mode: "audit-only",
    candidateCount: manifest.candidates.length,
    candidateBytes: manifest.budget.candidateBytes,
    blocked: manifest.budget.blocked,
    approvedObjectIds: [],
    dataDeleted: false,
    output: path.resolve(options.output)
  }));
  return manifest.budget.blocked ? 2 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(`cleanup artifact retention audit failed: ${error.message}`);
    process.exitCode = 2;
  });
}
