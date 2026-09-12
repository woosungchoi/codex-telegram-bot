import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { ensurePrivateDirectory, writePrivateFileAtomic } from "../fs/private.js";

export const DEFAULT_ACCOUNT_ID = "default";
const ID_PATTERN = /^[a-f0-9-]{36}$/;
const DEFAULT_ACCOUNT = { id: DEFAULT_ACCOUNT_ID, label: "Default", status: "ready", legacy: true };

export function accountHome(config, id = DEFAULT_ACCOUNT_ID) {
  if (id === DEFAULT_ACCOUNT_ID) return config.codexHome;
  if (!ID_PATTERN.test(id)) throw new Error("Invalid account id.");
  return path.join(config.codexAccountsDir, "profiles", id);
}

export function createAccountStore(config, { now = Date.now } = {}) {
  const root = config.codexAccountsDir;
  const index = path.join(root, "index.json");
  const lock = path.join(root, ".lock");
  async function reapStaleLock() {
    const reaper = path.join(root, ".reaping");
    try { await fs.mkdir(reaper, { mode: 0o700 }); } catch (error) {
      if (error.code === "EEXIST") return;
      throw error;
    }
    try {
      const owner = Number(await fs.readFile(lock, "utf8").catch(() => ""));
      const stat = await fs.stat(lock).catch(() => null);
      if ((owner > 0 && !processAlive(owner)) || (stat && now() - stat.mtimeMs > 30_000 && !owner)) {
        await fs.rm(lock, { force: true });
      }
    } finally { await fs.rmdir(reaper); }
  }
  async function read() {
    try {
      const data = JSON.parse(await fs.readFile(index, "utf8"));
      if (data.version !== 1 || !Array.isArray(data.accounts)) throw new Error("Invalid account registry.");
      return data;
    } catch (error) {
      if (error.code === "ENOENT") return { version: 1, autoRotate: false, accounts: [] };
      throw error;
    }
  }
  async function locked(fn) {
    await ensurePrivateDirectory(root);
    const deadline = now() + 5000;
    let handle;
    while (!handle) {
      try {
        handle = await fs.open(lock, "wx", 0o600);
        await handle.writeFile(String(process.pid));
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        await reapStaleLock();
        if (now() >= deadline) throw new Error("Account registry is busy. Try again shortly.");
        await delay(25);
      }
    }
    try {
      const data = await read();
      const result = await fn(data);
      await writePrivateFileAtomic(index, `${JSON.stringify(data, null, 2)}\n`);
      return result;
    } finally {
      await handle.close();
      await fs.rm(lock, { force: true });
    }
  }
  const listData = (data) => [
    { ...DEFAULT_ACCOUNT, ...(data.accounts.find((a) => a.id === DEFAULT_ACCOUNT_ID) || {}) },
    ...data.accounts.filter((a) => a.id !== DEFAULT_ACCOUNT_ID)
  ];
  async function list() { return listData(await read()); }
  async function get(id) {
    const account = (await list()).find((a) => a.id === id);
    if (!account) throw new Error("Account not found. Open /accounts.");
    return account;
  }
  async function update(id, fields) {
    return locked((data) => {
      const current = listData(data).find((a) => a.id === id);
      if (!current) throw new Error("Account not found.");
      const updated = { ...current, ...fields, id };
      data.accounts = [...data.accounts.filter((a) => a.id !== id), updated];
      return updated;
    });
  }
  async function create(label) {
    const account = { id: randomUUID(), label: cleanLabel(label || "ChatGPT"), status: "pending", createdAt: new Date(now()).toISOString() };
    try { await locked(async (data) => {
      if (data.accounts.length >= 20) throw new Error("At most 20 saved accounts are supported.");
      const home = accountHome(config, account.id);
      await ensurePrivateDirectory(home);
      // Share installed tools and user instructions; auth, sessions, databases
      // and model caches stay in the managed home. Never copy auth snapshots.
      for (const name of ["skills", "plugins", "rules", "AGENTS.md", "MEMORY.md"]) {
        const source = path.join(config.codexHome, name);
        if (await fs.stat(source).catch(() => null)) await fs.symlink(source, path.join(home, name));
      }
      const commonConfig = await fs.readFile(path.join(config.codexHome, "config.toml"), "utf8").catch((error) => {
        if (error.code === "ENOENT") return "";
        throw error;
      });
      await writePrivateFileAtomic(path.join(home, "config.toml"), commonConfig);
      data.accounts.push(account);
    }); } catch (error) {
      await fs.rm(accountHome(config, account.id), { recursive: true, force: true });
      throw error;
    }
    return account;
  }
  async function acquire(id, { allowUnavailable = false } = {}) {
    let lease;
    try { await locked(async (data) => {
      const account = listData(data).find((a) => a.id === id);
      if (!account || (account.status !== "ready" && !allowUnavailable)) throw new Error("Account needs sign-in. Open /reauth.");
      const dir = path.join(root, "leases", id);
      await ensurePrivateDirectory(dir);
      lease = path.join(dir, `${process.pid}-${randomUUID()}`);
      await fs.writeFile(lease, "", { mode: 0o600, flag: "wx" });
    }); } catch (error) {
      if (lease) await fs.rm(lease, { force: true });
      throw error;
    }
    return () => fs.rm(lease, { force: true });
  }
  async function remove(id) {
    if (id === DEFAULT_ACCOUNT_ID) throw new Error("The host's default account cannot be deleted here.");
    accountHome(config, id);
    await locked(async (data) => {
      const leaseDir = path.join(root, "leases", id);
      const leases = await fs.readdir(leaseDir).catch((error) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      if (leases.some((name) => processAlive(Number(name.split("-")[0])))) {
        throw new Error("This account has a running task. Wait for it to finish or use /stop.");
      }
      await fs.rm(accountHome(config, id), { recursive: true, force: true });
      await fs.rm(leaseDir, { recursive: true, force: true });
      data.accounts = data.accounts.filter((a) => a.id !== id);
    });
  }
  async function candidates() {
    const data = await read();
    if (!data.autoRotate) return [];
    return listData(data).filter((a) => a.status === "ready" && !(a.cooldownUntil > now()));
  }
  return {
    read, list, get, create, update, acquire, remove, candidates,
    rename: (id, label) => update(id, { label: cleanLabel(label) }),
    setAutoRotate: (enabled) => locked((data) => { data.autoRotate = enabled === true; }),
    markFailure: (id, failure) => update(id, {
      status: failure.kind === "auth" ? "reauth" : "ready",
      failureCode: failure.kind,
      cooldownUntil: failure.retryAt || now() + 15 * 60_000
    }),
    markSuccess: (id) => update(id, { status: "ready", failureCode: null, cooldownUntil: 0, lastUsedAt: new Date(now()).toISOString() })
  };
}

export function cleanLabel(label) {
  const value = String(label).replace(/\p{Cc}/gu, "").trim();
  if (!value || value.length > 48) throw new Error("Account name must contain 1–48 characters.");
  return value;
}
function processAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}
