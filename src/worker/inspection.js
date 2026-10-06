import { readAppServerThread } from "../codex/app_server.js";
import { accountConfig } from "../accounts/context.js";
import { extractMessageText } from "../codex/stream.js";

// Inspection never starts, resumes, steers, retries or rewrites a terminal job.
export async function inspectWorkerJob(params, { store, config, readThread = readAppServerThread }) {
  const job = await store.readJobState(params.jobId);
  if (!job?.requesterUserId || job.chatKey !== params.chatKey || String(job.requesterUserId) !== String(params.userId)) throw new Error("Inspection owner mismatch");
  const receipt = job.inputReceipt;
  const result = { jobId: job.id, status: job.status, receipt: receipt ? ["accepted", "confirmed"].includes(receipt.status) ? "accepted" : "uncertain" : ["accepted", "pending"].includes(job.status) ? "unsent" : "uncertain",
    progress: job.nativeProgress || {}, result: "", steers: Object.values(job.steers || {}).map((r) => ({ status: r.status })) };
  if (job.status === "completed") {
    let cursor = 0;
    while (true) {
      const events = await store.readJobEvents(job.id, { afterSeq: cursor, limit: 500 });
      if (!events.length) break;
      for (const event of events) {
        const item = event.params?.item || event.item;
        if (item && ["agentMessage", "agent_message"].includes(item.type) && (!item.phase || item.phase === "final_answer")) result.result = extractMessageText(item);
      }
      const next = Number(events.at(-1).seq);
      if (!(next > cursor)) break;
      cursor = next;
    }
    result.receipt = "recovered";
    return result;
  }
  if (!params.remote || !receipt?.threadId || !receipt?.clientId) return result;
  try {
    const response = await readThread({ ...accountConfig(config, receipt.accountId || "default"), threadId: receipt.threadId, includeTurns: true });
    if (response?.thread?.id !== receipt.threadId) return result;
    const turn = response.thread.turns?.find((t) => (!receipt.turnId || t.id === receipt.turnId)
      && t.items?.some((i) => i.type === "userMessage" && i.clientId === receipt.clientId));
    if (!turn) return result;
    result.receipt = "accepted";
    result.nativeStatus = turn.status;
    if (turn.status === "completed") {
      result.receipt = "recovered";
      result.result = (turn.items || []).filter((i) => i.type === "agentMessage" && (!i.phase || i.phase === "final_answer")).map(extractMessageText).join("\n\n");
    }
  } catch { result.inspectionUnavailable = true; }
  return result;
}
