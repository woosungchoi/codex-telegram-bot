import { localizedErrorDetails } from "../i18n.js";
import { randomUUID } from "node:crypto";

export function createRequestId(prefix = "req") {
  return `${prefix}_${randomUUID()}`;
}

export function encodeFrame(payload) {
  return `${JSON.stringify(payload)}\n`;
}

export function okResponse(id, result = {}) {
  return { id, ok: true, result };
}

export function errorResponse(id, error) {
  return {
    id,
    ok: false,
    error: {
      ...localizedErrorDetails(error),
      message: error instanceof Error ? error.message : String(error || "Worker request failed.")
    }
  };
}

export const MAX_WORKER_FRAME_BYTES = 8 * 1024 * 1024;
export function createFrameReader(stream, onFrame, {
  onError = () => {}, maxBytes = MAX_WORKER_FRAME_BYTES, frameTimeoutMs = 30_000
} = {}) {
  let buffer = null, size = 0, ended = false, timer;
  const reset = () => { buffer = null; size = 0; clearTimeout(timer); timer = undefined; };
  const cleanup = () => {
    ended = true;
    reset();
    stream.off("data", onData);
    stream.off("end", onEnd);
    stream.off("close", onEnd);
  };
  const fail = (error) => {
    cleanup();
    try { onError(error); } finally { stream.destroy(); }
  };
  const onData = (chunk) => {
    if (ended) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let start = 0;
    while (start < bytes.length && !ended) {
      const newline = bytes.indexOf(10, start);
      const end = newline < 0 ? bytes.length : newline;
      const length = end - start;
      if (size + length > maxBytes) { fail(new Error("Worker frame exceeds byte limit.")); return; }
      if (length) {
        // Bound both byte storage and fragment metadata for byte-at-a-time peers.
        if (!buffer || buffer.length < size + length) {
          const next = Buffer.allocUnsafe(Math.min(maxBytes, Math.max(4096, (buffer?.length || 0) * 2, size + length)));
          buffer?.copy(next, 0, 0, size);
          buffer = next;
        }
        bytes.copy(buffer, size, start, end);
        size += length;
        if (!timer) {
          timer = setTimeout(() => fail(new Error("Incomplete worker frame timed out.")), frameTimeoutMs);
          timer.unref?.();
        }
      }
      if (newline < 0) break;
      const line = buffer?.toString("utf8", 0, size) || "";
      reset();
      if (line.trim()) {
        try { onFrame(JSON.parse(line)); }
        catch (error) { onError(error); }
      }
      start = newline + 1;
    }
  };
  const onEnd = () => {
    if (ended) return;
    const incomplete = size > 0;
    cleanup();
    if (incomplete) onError(new Error("Incomplete worker frame at end of stream."));
  };
  stream.on("data", onData);
  stream.on("end", onEnd);
  stream.on("close", onEnd);
  return cleanup;
}
