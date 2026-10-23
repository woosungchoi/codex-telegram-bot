import fs from "node:fs/promises";
import path from "node:path";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { anchoredCreate } from "../fs/anchored.js";
import { readBoundedFile } from "../fs/bounded.js";

export const DEFAULT_CONTROL_DIR = "/var/lib/codex-telegram-bot-control";
export function controlDir(config = {}) { return config.maintenanceControlDir || DEFAULT_CONTROL_DIR; }
export async function controlKey(directory) {
  const file = path.join(directory, "approval.key");
  const readKey = async () => {
    const key = await readBoundedFile(file, 32, { privateMode: true });
    if (key.length !== 32) throw new Error("Invalid control key length.");
    return key;
  };
  try { return await readKey(); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    try { await anchoredCreate(directory, "approval.key", randomBytes(32)); }
    catch (collision) { if (collision.code !== "EEXIST") throw collision; }
    return readKey();
  }
}
export async function signControlRecord(directory, id, payload) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid control record ID.");
  const body = JSON.stringify(payload);
  const mac = createHmac("sha256", await controlKey(directory)).update(body).digest("hex");
  await anchoredCreate(directory, `${id}.json`, JSON.stringify({ body, mac }));
  return { directory, id };
}
export async function readControlRecord(directory, id) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid control record ID.");
  const record = JSON.parse((await readBoundedFile(path.join(directory, `${id}.json`), 16 * 1024 * 1024, { privateMode: true })).toString());
  const expected = createHmac("sha256", await controlKey(directory)).update(record.body).digest();
  const actual = Buffer.from(record.mac || "", "hex");
  if (actual.length !== expected.length || !timingSafeEqual(expected, actual)) throw new Error("Control approval authentication failed.");
  return JSON.parse(record.body);
}
// Kept separate from model output and staging. Directory placement is a sandbox
// boundary, not protection from a fully unsandboxed process with the same UID.
export async function requireControlSeparation(directory, writableRoots) {
  const target = path.resolve(directory);
  for (const root of writableRoots.filter(Boolean)) {
    const relative = path.relative(path.resolve(root), target);
    if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) throw new Error("Control directory overlaps a model writable root.");
  }
  await fs.access(target);
}
