import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

export async function approvedArtifact(config, target) {
  if (!config.codexUpdateTrustFile) throw new Error("CLI update disabled: configure an independently reviewed CODEX_UPDATE_TRUST_FILE first.");
  const file = await fs.open(config.codexUpdateTrustFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 64 * 1024 || (stat.mode & 0o022)) throw new Error("Unsafe update trust manifest.");
    const manifest = JSON.parse(await file.readFile("utf8"));
    const entry = manifest.artifacts?.find((a) => a.version === target && a.platform === process.platform && a.arch === process.arch);
    if (!entry || !/^[a-f0-9]{64}$/.test(entry.sha256) || entry.format !== "tar.gz") throw new Error("No independently approved artifact for this version/platform.");
    const url = new URL(entry.url);
    if (url.protocol !== "https:" || url.username || url.password || !/^[A-Za-z0-9._-]+$/.test(entry.binary)) throw new Error("Invalid approved artifact metadata.");
    return entry;
  } finally { await file.close(); }
}

export function extractApprovedBinary(compressed, entry) {
  if (compressed.length > 256 * 1024 * 1024 || createHash("sha256").update(compressed).digest("hex") !== entry.sha256) throw new Error("Update artifact digest mismatch.");
  const tar = gunzipSync(compressed, { maxOutputLength: 512 * 1024 * 1024 });
  let binary = null;
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (a, b) => header.subarray(a, b).toString("utf8").replace(/\0.*$/s, "");
    const stored = field(148, 156).trim();
    const actual = [...header].reduce((sum, byte, i) => sum + (i >= 148 && i < 156 ? 32 : byte), 0);
    if (!/^[0-7]+$/.test(stored) || parseInt(stored, 8) !== actual) throw new Error("Invalid tar header checksum.");
    const name = [field(345, 500), field(0, 100)].filter(Boolean).join("/");
    const sizeField = field(124, 136).trim();
    const type = header[156];
    if (!/^[0-7]+$/.test(sizeField) || !name || name.startsWith("/") || name.includes("\\") || name.split("/").includes("..") || ![0, 48, 53].includes(type)) throw new Error("Unsafe archive entry (path, link or extension).");
    const size = parseInt(sizeField, 8);
    if (!Number.isSafeInteger(size) || offset + 512 + size > tar.length) throw new Error("Truncated update archive.");
    if (type !== 53) {
      if (path.basename(name) !== entry.binary || binary) throw new Error("Unexpected or duplicate executable in update artifact.");
      binary = Buffer.from(tar.subarray(offset + 512, offset + 512 + size));
    } else if (size !== 0) throw new Error("Invalid archive directory.");
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (!binary?.length) throw new Error("Approved binary missing from artifact.");
  return binary;
}
