import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { openAnchoredDirectory } from "../fs/anchored.js";

export async function dependencyTreeDigest(root) {
  const digest = createHash("sha256");
  const visit = async (dir, relative = "") => {
    const anchor = `/proc/self/fd/${dir.fd}`;
    for (const name of (await fs.readdir(anchor)).sort()) {
      const location = `${anchor}/${name}`, key = path.join(relative, name);
      const stat = await fs.lstat(location);
      digest.update(JSON.stringify([key, stat.mode]));
      if (stat.isSymbolicLink()) {
        const target = await fs.readlink(location);
        const resolved = path.resolve(root, relative, target);
        if (!resolved.startsWith(`${path.resolve(root)}/`)) throw new Error("Dependency symlink escapes tree.");
        digest.update(JSON.stringify(["symlink", target]));
      } else if (stat.isDirectory()) {
        const child = await fs.open(location, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try { await visit(child, key); } finally { await child.close(); }
      } else if (stat.isFile() && stat.nlink === 1) {
        const file = await fs.open(location, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const before = await file.stat();
          if (!before.isFile() || before.ino !== stat.ino || before.dev !== stat.dev) throw new Error("Dependency file replaced.");
          const buffer = Buffer.alloc(64 * 1024);
          let size = 0;
          for (;;) {
            const { bytesRead } = await file.read(buffer, 0, buffer.length, size);
            if (!bytesRead) break;
            size += bytesRead; digest.update(buffer.subarray(0, bytesRead));
            if (size > before.size) throw new Error("Dependency file grew during verification.");
          }
          const after = await file.stat();
          if (size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error("Dependency file changed during verification.");
        } finally { await file.close(); }
      } else throw new Error("Unsafe dependency tree entry.");
    }
  };
  const directory = await openAnchoredDirectory(path.resolve(root));
  try { await visit(directory); return digest.digest("hex"); } finally { await directory.close(); }
}
