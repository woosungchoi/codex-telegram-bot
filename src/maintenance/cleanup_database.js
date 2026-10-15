import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  anchoredCreate,
  anchoredUnlink,
  fileIdentity,
  openAnchoredDirectory,
} from "../fs/anchored.js";
import { accountHome, createAccountStore } from "../accounts/store.js";

const HELPER = fileURLToPath(
  new URL("../../scripts/cleanup_database.py", import.meta.url),
);
const ID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;

export async function cleanupAccountRoots(config) {
  const roots = [
    {
      home: path.resolve(config.codexHome),
      sessionsRoot: path.resolve(config.codexSessionsDir),
      key: "default",
    },
  ];
  if (config.cleanupDatabaseEnabled && config.codexAccountsDir) {
    for (const account of await createAccountStore(config).list()) {
      if (account.id === "default") continue;
      const home = accountHome(config, account.id);
      roots.push({
        home,
        sessionsRoot: path.join(home, "sessions"),
        key: account.id,
      });
    }
  }
  return roots;
}

export function runCleanupDatabase(request) {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [HELPER], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    });
    let output = "",
      size = 0,
      failure;
    const timeout = setTimeout(() => {
      failure = new Error("Database maintenance timed out; retry is retained.");
      child.kill("SIGKILL");
    }, 120_000);
    child.stdout.on("data", (data) => {
      size += data.length;
      if (size > 1024 * 1024) {
        failure = new Error("Database maintenance output exceeded limit.");
        child.kill("SIGKILL");
      } else output += data;
    });
    child.stderr.resume();
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.stdin.on("error", () => {});
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (failure) return reject(failure);
      try {
        const result = JSON.parse(output);
        if (code !== 0 || result.ok !== true)
          throw new Error(result.error || "Database maintenance failed.");
        resolve(result);
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

async function privateJson(file) {
  const parent = await openAnchoredDirectory(path.dirname(file));
  let handle;
  try {
    handle = await fs.open(
      `/proc/self/fd/${parent.fd}/${path.basename(file)}`,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const s = await handle.stat();
    if (
      !s.isFile() ||
      s.nlink !== 1 ||
      s.uid !== process.getuid() ||
      s.size > 64 * 1024
    )
      throw new Error("Invalid database cleanup receipt.");
    return JSON.parse(await handle.readFile("utf8"));
  } finally {
    await handle?.close();
    await parent.close();
  }
}

async function syncReceipt(file) {
  const parent = await openAnchoredDirectory(path.dirname(file));
  let handle;
  try {
    handle = await fs.open(
      `/proc/self/fd/${parent.fd}/${path.basename(file)}`,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    await handle.sync();
    await parent.sync();
  } finally {
    await handle?.close();
    await parent.close();
  }
}

export function createCleanupDatabase({
  config,
  protectedIds,
  run = runCleanupDatabase,
}) {
  const directory = path.join(config.cleanupArtifactDir, "database-pending");
  async function entries() {
    const names = await fs.readdir(directory).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    return names
      .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
      .map((name) => path.join(directory, name));
  }
  async function binding(candidate) {
    const roots = await cleanupAccountRoots(config);
    const original = path.resolve(candidate.originalPath || candidate.path);
    const root = roots.find(
      (entry) =>
        entry.home === (candidate.codexHome || config.codexHome) &&
        original.startsWith(`${entry.sessionsRoot}${path.sep}`),
    );
    if (!root || !ID.test(candidate.threadId))
      throw new Error("Unverifiable account or thread binding.");
    return {
      home: root.home,
      sessionsRoot: root.sessionsRoot,
      threadId: candidate.threadId,
      originalPath: original,
    };
  }
  async function inspect(candidate, phase = "delete") {
    const request = {
      ...(await binding(candidate)),
      action: "inspect",
      phase,
      quarantinedAtMs: Date.parse(candidate.quarantinedAt),
      protectedIds: [...(await protectedIds())],
    };
    return run(request);
  }
  async function prepare(candidate, metadata) {
    if (
      metadata?.threadId !== candidate.threadId ||
      metadata?.originalPath !== candidate.originalPath
    )
      throw new Error(
        "Database deletion requires matching quarantine metadata.",
      );
    const parent = await openAnchoredDirectory(path.dirname(candidate.path));
    let file;
    try {
      file = await fs.open(
        `/proc/self/fd/${parent.fd}/${path.basename(candidate.path)}`,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const stat = await file.stat();
      const identity = fileIdentity(stat);
      if (
        stat.nlink !== 1 ||
        identity.ino !== candidate.identity?.ino ||
        identity.dev !== candidate.identity?.dev
      )
        throw new Error("Quarantine identity changed.");
      const buffer = Buffer.alloc(65536);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      const first = buffer
        .subarray(0, bytesRead)
        .toString("utf8")
        .split("\n")[0];
      const meta = JSON.parse(first);
      if (
        meta.type !== "session_meta" ||
        meta.payload?.id !== candidate.threadId
      )
        throw new Error("Quarantine session ID mismatch.");
    } finally {
      await file?.close();
      await parent.close();
    }
    await inspect(candidate);
    const record = {
      schema: 1,
      ...(await binding(candidate)),
      quarantinePath: path.resolve(candidate.path),
      quarantinedAtMs: Date.parse(metadata.quarantinedAt),
      createdAt: new Date().toISOString(),
    };
    if (!Number.isFinite(record.quarantinedAtMs))
      throw new Error("Invalid quarantine date.");
    const name = `${createHash("sha256").update(`${record.home}\0${record.threadId}`).digest("hex")}.json`;
    try {
      await anchoredCreate(directory, name, `${JSON.stringify(record)}\n`);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const previous = await privateJson(path.join(directory, name));
      for (const key of [
        "schema",
        "home",
        "threadId",
        "originalPath",
        "quarantinePath",
        "quarantinedAtMs",
      ]) {
        if (previous[key] !== record[key])
          throw new Error("Conflicting database cleanup receipt.");
      }
    }
    await syncReceipt(path.join(directory, name));
  }
  async function preview(candidates) {
    let rows = 0,
      blocked = 0;
    for (const candidate of candidates) {
      try {
        rows += (await inspect(candidate)).rows;
      } catch {
        blocked += 1;
      }
    }
    return { rows, blocked, pending: await pendingCount() };
  }
  async function drain(quarantineDays) {
    const result = {
      deletedRows: 0,
      completed: 0,
      deferred: 0,
      reclaimedBytes: 0,
      errors: [],
    };
    const pending = await entries();
    result.deferred += Math.max(0, pending.length - 256);
    for (const receipt of pending.slice(0, 256)) {
      try {
        const record = await privateJson(receipt);
        if (
          record.schema !== 1 ||
          !Number.isFinite(record.quarantinedAtMs) ||
          record.quarantinedAtMs >= Date.now() - quarantineDays * 86400000
        )
          throw new Error("Database cleanup receipt is not expired.");
        const root = (await cleanupAccountRoots(config)).find(
          (entry) =>
            entry.home === record.home &&
            entry.sessionsRoot === record.sessionsRoot,
        );
        const relative = path.relative(
          config.cleanupQuarantineDir,
          record.quarantinePath,
        );
        if (
          !root ||
          !relative ||
          relative.startsWith("..") ||
          path.isAbsolute(relative)
        )
          throw new Error(
            "Database cleanup receipt is outside configured roots.",
          );
        if (
          await fs.lstat(record.quarantinePath).catch((error) => {
            if (error.code === "ENOENT") return null;
            throw error;
          })
        ) {
          result.deferred += 1;
          continue;
        }
        const applied = await run({
          ...record,
          action: "delete",
          protectedIds: [...(await protectedIds())],
        });
        result.deletedRows += applied.deletedRows;
        result.completed += 1;
        // Keep a compact-only retry marker before retiring the deletion journal.
        const name = `${createHash("sha256").update(record.home).digest("hex")}.compact`;
        await anchoredCreate(
          directory,
          name,
          JSON.stringify({ home: record.home }),
        ).catch((error) => {
          if (error.code !== "EEXIST") throw error;
        });
        await syncReceipt(path.join(directory, name));
        await anchoredUnlink(
          directory,
          receipt,
          fileIdentity(await fs.lstat(receipt)),
        );
      } catch (error) {
        result.deferred += 1;
        result.errors.push(error.message);
      }
    }
    const markers = (
      await fs.readdir(directory).catch((error) => {
        if (error.code === "ENOENT") return [];
        throw error;
      })
    ).filter((name) => /^[a-f0-9]{64}\.compact$/.test(name));
    for (const name of markers) {
      const file = path.join(directory, name);
      try {
        const { home } = await privateJson(file);
        if (
          !(await cleanupAccountRoots(config)).some(
            (entry) => entry.home === home,
          )
        )
          throw new Error("Unknown compact account.");
        const report = await run({ home, action: "compact" });
        result.reclaimedBytes += report.databases.reduce(
          (n, row) => n + row.reclaimedBytes,
          0,
        );
        if (report.deferred) result.deferred += 1;
        else
          await anchoredUnlink(
            directory,
            file,
            fileIdentity(await fs.lstat(file)),
          );
      } catch (error) {
        result.deferred += 1;
        result.errors.push(error.message);
      }
    }
    return result;
  }
  async function pendingCount() {
    const files = await fs.readdir(directory).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    return files.filter((name) => /^[a-f0-9]{64}\.(json|compact)$/.test(name))
      .length;
  }
  return { inspect, prepare, preview, drain, pendingCount };
}
