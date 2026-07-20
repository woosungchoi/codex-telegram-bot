import {
  applyCodexStreamEvent,
  codexStreamResult,
  createCodexStreamState
} from "../codex/stream.js";

export async function reconstructCompletedWorkerJob(client, jobId) {
  const streamState = createCodexStreamState();
  let cursor = 0;
  let terminal = null;
  let threadId = "";

  while (!terminal) {
    const response = await client.readJobEvents(jobId, cursor, 500);
    const events = response.events || [];
    if (events.length === 0) {
      const status = await client.getJobStatus(jobId);
      const job = status?.job;
      if (!isTerminalWorkerStatus(job?.status)) {
        throw new Error(`Worker job ${jobId} is not terminal.`);
      }
      const lastSeq = Number(job.lastSeq || 0);
      if (Number.isFinite(lastSeq) && cursor < lastSeq) {
        throw new Error(`Worker job ${jobId} event log is incomplete (${cursor}/${lastSeq}).`);
      }
      terminal = { type: `worker.job.${job.status}`, status: job.status, message: job.error || "" };
      break;
    }

    for (const event of events) {
      cursor = Math.max(cursor, Number(event.seq || 0));
      const eventType = String(event.type || "");
      if (event.threadId) threadId = event.threadId;
      if (eventType.startsWith("worker.job.")) {
        if (isTerminalWorkerEvent(event)) terminal = event;
        continue;
      }
      const update = applyCodexStreamEvent(streamState, event);
      if (update.type === "thread_started") threadId = update.threadId || threadId;
      if (update.type === "error") throw new Error(update.message);
    }
  }

  if (terminal?.type === "worker.job.failed") throw new Error(terminal.message || "Codex worker job failed.");
  if (terminal?.type === "worker.job.cancelled") throw new Error(terminal.message || "Codex worker job was cancelled.");
  if (terminal?.status !== "completed" && terminal?.type !== "worker.job.completed") {
    throw new Error(`Worker job ${jobId} did not complete successfully.`);
  }
  return {
    turn: codexStreamResult(streamState),
    threadId,
    workerLastSeq: cursor
  };
}

export function isTerminalWorkerEvent(event) {
  return event?.type === "worker.job.completed"
    || event?.type === "worker.job.failed"
    || event?.type === "worker.job.cancelled";
}

export function isTerminalWorkerStatus(status) {
  return status === "completed" || status === "failed" || status === "cancelled";
}
