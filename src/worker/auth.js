import fs from "node:fs/promises";
import { constants } from "node:fs";
import { randomBytes, timingSafeEqual, createHmac } from "node:crypto";
import { writePrivateFileAtomic } from "../fs/private.js";

export async function createWorkerCredential(socketPath) {
  const token = randomBytes(32).toString("hex");
  await writePrivateFileAtomic(`${socketPath}.auth`, token);
  return token;
}

export async function readWorkerCredential(socketPath) {
  const file = await fs.open(`${socketPath}.auth`, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size !== 64 || (stat.mode & 0o077)) throw new Error("Unsafe worker credential file.");
    return await file.readFile("utf8");
  } finally { await file.close(); }
}

function equal(a, b) {
  return typeof a === "string" && typeof b === "string" && Buffer.byteLength(a) === Buffer.byteLength(b)
    && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function questionCapability(secret, jobId, expires = Date.now() + 7 * 86400_000) {
  const body = Buffer.from(JSON.stringify({ jobId, expires })).toString("base64url");
  return `${body}.${createHmac("sha256", secret).update(body).digest("hex")}`;
}

export function authorizeWorkerRequest(secret, request, now = Date.now()) {
  if (equal(secret, request?.auth)) return;
  if (request?.method === "question/ask" && typeof request.auth === "string") {
    const [body, signature, extra] = request.auth.split(".");
    if (!extra && body && equal(createHmac("sha256", secret).update(body).digest("hex"), signature)) {
      const scope = JSON.parse(Buffer.from(body, "base64url").toString());
      if (scope.jobId === request.params?.jobId && scope.expires > now) return;
    }
  }
  throw new Error("Worker request is not authorized.");
}

// Same-UID read-only/workspace sandboxes do not protect the IPC credential.
// Until an OS-isolated executor is available, never represent that deployment
// as a lower-trust sandbox. Inline mode remains available for sandboxed work.
export function assertWorkerExecutionBoundary(config, options) {
  if (config.codexSandboxMode !== "danger-full-access"
    || options.sandboxMode !== "danger-full-access"
    || (Array.isArray(options.explicitOptions) && !options.explicitOptions.includes("sandboxMode"))) {
    throw new Error("Sidecar execution requires a trusted danger-full-access operator configuration. Sandboxed work requires inline mode or an OS-isolated executor.");
  }
}
