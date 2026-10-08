import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
export function tarFixture({ name = "codex-test", type = "0", body = "verified executable", extra = [] } = {}) {
  const buffers = [];
  for (const entry of [{ name, type, body }, ...extra]) {
    const data = Buffer.from(entry.body || "");
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100);
    header.write("0000700\0", 100);
    header.write(data.length.toString(8).padStart(11, "0") + "\0", 124);
    header.fill(32, 148, 156);
    header.write(entry.type || "0", 156);
    header.write([...header].reduce((a, b) => a + b, 0).toString(8).padStart(6, "0") + "\0 ", 148);
    buffers.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  const archive = gzipSync(Buffer.concat([...buffers, Buffer.alloc(1024)]));
  return { archive, entry: { version: "0.160.0", platform: process.platform, arch: process.arch, format: "tar.gz", binary: "codex-test", url: "https://example.invalid/codex.tar.gz", sha256: createHash("sha256").update(archive).digest("hex") } };
}
