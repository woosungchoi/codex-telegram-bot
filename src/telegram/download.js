import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { LocalizedError } from "../i18n.js";

let activeDownloads = 0;
const MAX_DOWNLOADS = 4;
const HARD_MAX_BYTES = 1024 * 1024 * 1024;

export async function downloadAttachment({ getLink, fetchImpl, agent, uploadDir, maxBytes, ext, formatBytes }) {
  if (activeDownloads >= MAX_DOWNLOADS) throw new Error("Attachment download capacity reached. Retry after an active download completes.");
  activeDownloads++;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  timer.unref?.();
  let response, directory, handle, storedPath, complete = false;
  const limit = maxBytes > 0 ? Math.min(maxBytes, HARD_MAX_BYTES) : HARD_MAX_BYTES;
  const tooLarge = (bytes) => new LocalizedError("errors.telegramUploadLimit", { size: formatBytes(bytes), limit: formatBytes(limit) });
  try {
    const link = await getLink();
    response = await fetchImpl(link.href, { agent, signal: controller.signal });
    if (!response.ok) throw new LocalizedError("errors.telegramDownload", { status: response.status });
    const declared = Number(response.headers?.get("content-length"));
    if (declared > limit) throw tooLarge(declared);
    if (!response.body?.[Symbol.asyncIterator]) throw new Error("Streaming attachment response required.");
    const root = path.resolve(uploadDir);
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    if (await fs.realpath(root) !== root) throw new Error("Upload directory must not contain symlinks.");
    directory = await fs.open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    // Linux dirfd anchoring prevents a renamed/replaced parent redirecting writes.
    // Fail closed on platforms without this primitive instead of reopening a path.
    const anchor = `/proc/self/fd/${directory.fd}`;
    if (await fs.realpath(anchor) !== root) throw new Error("Upload directory changed.");
    const suffix = /^\.[a-zA-Z0-9]{1,10}$/.test(ext) ? ext.toLowerCase() : ".bin";
    const name = `${randomUUID()}${suffix}`;
    storedPath = path.join(anchor, name);
    handle = await fs.open(storedPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let bytes = 0;
    for await (const chunk of response.body) {
      if (controller.signal.aborted) throw new Error("Attachment download timed out.");
      bytes += chunk.byteLength;
      if (bytes > limit) throw tooLarge(bytes);
      await handle.writeFile(chunk);
    }
    if (await fs.realpath(anchor) !== root) throw new Error("Upload directory moved during download.");
    complete = true;
    return { path: path.join(root, name), bytes };
  } finally {
    clearTimeout(timer);
    controller.abort();
    response?.body?.destroy?.();
    await handle?.close().catch(() => {});
    if (!complete && storedPath) await fs.unlink(storedPath).catch(() => {});
    await directory?.close().catch(() => {});
    activeDownloads--;
  }
}
