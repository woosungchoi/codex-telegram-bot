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

export function createFrameReader(stream, onFrame, { onError = () => {} } = {}) {
  let buffer = "";
  const onData = (chunk) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        onFrame(JSON.parse(line));
      } catch (error) {
        onError(error, line);
      }
    }
  };
  stream.on("data", onData);
  return () => stream.off("data", onData);
}
