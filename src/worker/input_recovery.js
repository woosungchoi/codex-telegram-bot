import { readAppServerThread, appServerThreadReadEvents } from "../codex/app_server.js";
import { accountConfig } from "../accounts/context.js";

// Read-only recovery: a native ID proves receipt, not idempotency. Only an
// already completed matching turn can be reconstructed without running it again.
export async function recoverCompletedInput(job, { config, store, readThread = readAppServerThread }) {
  const receipt = job.inputReceipt;
  if (!receipt?.clientId || !receipt.threadId) return false;
  let response;
  try {
    response = await readThread({ ...accountConfig(config, receipt.accountId || "default"), threadId: receipt.threadId, includeTurns: true });
  } catch { return false; }
  if (response?.thread?.id !== receipt.threadId) return false;
  const turn = response.thread.turns?.find((candidate) =>
    (!receipt.turnId || candidate.id === receipt.turnId) && candidate.status === "completed"
    && candidate.items?.some((item) => item.type === "userMessage" && item.clientId === receipt.clientId));
  if (!turn) return false;
  for (const event of appServerThreadReadEvents(response, { threadId: receipt.threadId, turnId: turn.id })) {
    await store.appendJobEvent(job.id, { ...event, threadId: receipt.threadId, accountId: receipt.accountId || "default", chatKey: job.chatKey });
  }
  await store.writeJobState({ id: job.id, inputReceipt: { ...receipt, turnId: turn.id, status: "confirmed" } });
  await store.appendJobEvent(job.id, { type: "worker.job.completed", status: "completed", threadId: receipt.threadId,
    accountId: receipt.accountId || "default", chatKey: job.chatKey, recoveredBy: "native-client-id", completedAt: new Date().toISOString() });
  return true;
}
