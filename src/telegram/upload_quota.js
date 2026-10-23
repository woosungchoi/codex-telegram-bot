import fs from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";

export const DEFAULT_UPLOAD_QUOTA = 5 * 1024 ** 3;
export const DEFAULT_UPLOAD_FREE = 1024 ** 3;

// One kernel lock covers the complete stream, across processes. Partial files
// left by a crash are counted on the next admission; no orphan is auto-deleted.
export async function acquireUploadQuota(anchor, { quotaBytes = DEFAULT_UPLOAD_QUOTA, minFreeBytes = DEFAULT_UPLOAD_FREE } = {}) {
  if (!Number.isSafeInteger(quotaBytes) || quotaBytes <= 0 || !Number.isSafeInteger(minFreeBytes) || minFreeBytes < 0) throw new Error("Invalid upload quota.");
  const lock = await fs.open(`${anchor}/.upload-quota.lock`, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  const child = spawn("/usr/bin/flock", ["-x", "-w", "120", "/proc/self/fd/3", process.execPath, "-e",
    'process.stdout.write("locked\\n");process.stdin.resume();process.stdin.on("end",()=>process.exit(0));'],
  { stdio: ["pipe", "pipe", "pipe", lock.fd], env: { PATH: "/usr/bin:/bin" } });
  const closed = new Promise((resolve) => { child.once("close", resolve); child.once("error", resolve); });
  child.stdin.on("error", () => {});
  try {
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", () => reject(new Error("Upload quota is busy. Retry after the active upload completes.")));
      child.stdout.once("data", (data) => data.toString() === "locked\n" ? resolve() : reject(new Error("Quota lock failed.")));
    });
    const count = async (directory, depth = 0) => {
      if (depth > 1) throw new Error("Unexpected nested upload directory.");
      let total = 0;
      for (const name of await fs.readdir(directory)) {
        const file = `${directory}/${name}`;
        const stat = await fs.lstat(file);
        if (stat.isFile() && stat.nlink === 1) total += stat.size;
        else if (stat.isDirectory() && /^[a-f0-9-]{36}$/.test(name)) {
          const handle = await fs.open(file, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
          try { total += await count(`/proc/self/fd/${handle.fd}`, depth + 1); } finally { await handle.close(); }
        } else throw new Error("Upload inventory contains an unsupported entry; reconcile before uploading.");
      }
      return total;
    };
    const committed = await count(anchor);
    let reserved = 0;
    return {
      async grow(bytes) {
        if (child.exitCode !== null || child.signalCode !== null) throw new Error("Upload quota lock lost.");
        if (committed + reserved + bytes > quotaBytes) throw new Error("Upload storage quota exceeded; existing files were preserved.");
        const free = await fs.statfs(anchor);
        if (free.bavail * free.bsize - bytes < minFreeBytes) throw new Error("Insufficient free disk space for upload.");
        reserved += bytes;
      },
      async release() { child.stdin.end(); await closed; await lock.close(); }
    };
  } catch (error) {
    child.stdin.end(); await closed; await lock.close(); throw error;
  }
}
