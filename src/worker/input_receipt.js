// Presentation only: a worker accepting a job is not Codex accepting its input.
export function workerInputReceipt(job) {
  if (job.status === "completed") return "recovered";
  const status = job.inputReceipt?.status;
  if (["accepted", "confirmed"].includes(status)) return "accepted";
  if (["failed", "cancelled", "interrupted"].includes(job.status)) return "uncertain";
  if (status === "sending") return "pending";
  if (status) return "uncertain";
  return ["accepted", "pending"].includes(job.status) ? "unsent" : "not_checked";
}
