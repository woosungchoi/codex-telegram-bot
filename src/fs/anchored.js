import fs from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";

// Linux procfs resolves these paths through an already-open directory, rather
// than re-traversing attacker-writable ancestors at mutation time. Fail closed
// on other platforms. A realpath check followed by a path-based write is unsafe.
function supported() {
  if (process.platform !== "linux") throw new Error("Anchored maintenance requires Linux procfs; no path-based fallback.");
}
function child(handle, name) { return `/proc/self/fd/${handle.fd}/${name}`; }
function components(value) {
  const parts = value.split(path.sep);
  if (parts.some((p) => p === ".." || p === ".")) throw new Error("Invalid anchored path.");
  return parts.filter(Boolean);
}
export function fileIdentity(stat) {
  return { dev: String(stat.dev), ino: String(stat.ino), type: "file" };
}
function matches(stat, identity) {
  return identity?.type === "file" && stat.isFile() && String(stat.dev) === identity.dev && String(stat.ino) === identity.ino;
}

export async function openAnchoredDirectory(directory, { create = false } = {}) {
  supported();
  if (!path.isAbsolute(directory)) throw new Error("Absolute anchored root required.");
  let handle = await fs.open("/", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    for (const part of components(directory)) {
      const name = child(handle, part);
      if (create) {
        try { await fs.mkdir(name, { mode: 0o700 }); }
        catch (error) { if (error.code !== "EEXIST") throw error; }
      }
      const next = await fs.open(name, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      await handle.close();
      handle = next;
    }
    return handle;
  } catch (error) { await handle.close(); throw error; }
}

async function openParent(root, file, create = false) {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) throw new Error("File outside anchored root.");
  components(relative);
  // Pin every directory component, including the supplied root's ancestors.
  return { parent: await openAnchoredDirectory(path.dirname(path.resolve(file)), { create }), name: path.basename(file) };
}
async function verified(parent, name, identity) {
  const file = await fs.open(child(parent, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!matches(await file.stat({ bigint: true }), identity)) throw new Error("Cleanup candidate identity changed; request a new preview.");
    return file;
  } catch (error) { await file.close(); throw error; }
}
export async function anchoredUnlink(root, file, identity) {
  const { parent, name } = await openParent(root, file);
  let handle;
  try {
    handle = await verified(parent, name, identity);
    await fs.unlink(child(parent, name)); // unlink never follows the final entry
  } finally { await handle?.close(); await parent.close(); }
}
export async function anchoredMove(root, file, identity, targetRoot, target, metadata) {
  const source = await openParent(root, file);
  let destination, handle, copied = false, metadataCreated = false;
  try {
    handle = await verified(source.parent, source.name, identity);
    if ((await handle.stat()).nlink !== 1) throw new Error("Hardlinked cleanup candidate refused.");
    destination = await openParent(targetRoot, target, true);
    // linkat-style exclusive creation cannot overwrite an existing entry.
    // Cross-device moves fail closed instead of falling back to copy paths.
    await fs.link(child(source.parent, source.name), child(destination.parent, destination.name));
    copied = true;
    const pinned = await verified(destination.parent, destination.name, identity);
    try { await pinned.chmod(0o600); } finally { await pinned.close(); }
    if (metadata !== undefined) {
      await writeAt(destination.parent, `${destination.name}.cleanup.json`, metadata);
      metadataCreated = true;
    }
    // Recheck the source entry after staging. Its ancestors remain pinned.
    const current = await verified(source.parent, source.name, identity);
    await current.close();
    await fs.unlink(child(source.parent, source.name));
    copied = false;
  } finally {
    if (copied && destination) {
      await fs.unlink(child(destination.parent, destination.name)).catch(() => {});
      if (metadataCreated) await fs.unlink(child(destination.parent, `${destination.name}.cleanup.json`)).catch(() => {});
    }
    await handle?.close();
    await source.parent.close();
    await destination?.parent.close();
  }
}
async function writeAt(directory, name, data) {
  const file = await fs.open(child(directory, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.chmod(0o600); await file.writeFile(data, "utf8"); }
  catch (error) { await fs.unlink(child(directory, name)).catch(() => {}); throw error; }
  finally { await file.close(); }
}
export async function anchoredCreate(directory, name, data) {
  if (path.basename(name) !== name || !name || name === "." || name === "..") throw new Error("Invalid private filename.");
  const root = await openAnchoredDirectory(directory, { create: true });
  try { await root.chmod(0o700); await writeAt(root, name, data); }
  finally { await root.close(); }
  return path.join(directory, name);
}
