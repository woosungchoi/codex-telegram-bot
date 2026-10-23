import fs from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { openAnchoredDirectory } from "./anchored.js";

export async function readBoundedFile(file, maxBytes = 16 * 1024 * 1024, { privateMode = false } = {}) {
  const parent = await openAnchoredDirectory(path.dirname(path.resolve(file)));
  let handle;
  try {
    handle = await fs.open(`/proc/self/fd/${parent.fd}/${path.basename(file)}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes || (privateMode && ((stat.mode & 0o022) || stat.uid !== process.getuid()))) throw new Error("Unsafe file identity, permissions or size.");
    const bytes = Buffer.alloc(Math.min(maxBytes + 1, stat.size + 1));
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    const after = await handle.stat();
    if (offset !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error("File changed while reading.");
    return bytes.subarray(0, offset);
  } finally { await handle?.close(); await parent.close(); }
}
export async function probeDirectory(directory) {
  const parent = await openAnchoredDirectory(path.resolve(directory), { create: true });
  const name = `/proc/self/fd/${parent.fd}/.write-test-${randomUUID()}`;
  let file;
  try {
    file = await fs.open(name, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("Unsafe probe.");
    await file.writeFile("ok\n");
    await file.sync();
  } finally {
    if (file) { await file.close(); await fs.unlink(name).catch(() => {}); }
    await parent.close();
  }
}
