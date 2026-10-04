import { createHash } from "node:crypto";
import { buildInput } from "../codex/input.js";

// Durable intent is committed before delivery. A lost acknowledgement is held
// for inspection, never converted into a second execution of the same request.
export function createSteeringBroker({ store, controllers }) {
  const controls = new Map();
  const locks = new Map();
  function register(jobId, control) {
    controls.set(jobId, control);
    return () => { if (controls.get(jobId) === control) controls.delete(jobId); };
  }
  async function submit(params) {
    const previous = locks.get(params.jobId) || Promise.resolve();
    const task = previous.catch(() => {}).then(() => deliver(params));
    locks.set(params.jobId, task);
    try { return await task; }
    finally { if (locks.get(params.jobId) === task) locks.delete(params.jobId); }
  }
  async function deliver({ jobId, requestId, chatKey, userId, inputText, imagePaths = [] }) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(requestId || "") || typeof inputText !== "string" || inputText.length > 100_000
      || !Array.isArray(imagePaths) || imagePaths.length > 20 || imagePaths.some((p) => typeof p !== "string")) throw new Error("Invalid steering request");
    const job = await store.readJobState(jobId);
    if (!job?.requesterUserId || job.chatKey !== chatKey || String(job.requesterUserId) !== String(userId)) throw new Error("Steering owner mismatch");
    const hash = createHash("sha256").update(JSON.stringify({ inputText, imagePaths })).digest("hex");
    const prior = job.steers?.[requestId];
    if (prior) {
      if (prior.hash !== hash) throw new Error("Steering request ID reused with different input");
      return { status: prior.status === "sending" ? "unknown" : prior.status, turnId: prior.turnId };
    }
    const control = controls.get(jobId);
    if (!control || !controllers.has(jobId) || controllers.get(jobId).signal.aborted
      || job.userQuestion?.state === "pending" || !["running", "accepted"].includes(job.status)) return { status: "rejected" };
    const receipt = { hash, status: "sending", turnId: control.turnId, threadId: control.threadId, inputText, imagePaths, at: new Date().toISOString() };
    const steers = { ...job.steers, [requestId]: receipt };
    await store.writeJobState({ id: jobId, steers });
    let result;
    try { result = await control.steer(buildInput(inputText, imagePaths)); }
    catch { result = { status: "unknown" }; }
    receipt.status = ["accepted", "rejected"].includes(result?.status) ? result.status : "unknown";
    await store.writeJobState({ id: jobId, steers });
    await store.appendJobEvent(jobId, { type: "worker.steer", requestId, steerStatus: receipt.status, turnId: control.turnId });
    return { status: receipt.status, turnId: control.turnId };
  }
  return { register, submit };
}
