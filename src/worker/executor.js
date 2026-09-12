import { buildInput } from "../codex/input.js";
import { applyCodexStreamEvent, codexStreamResult, createCodexStreamState } from "../codex/stream.js";
import { createCodexThread as createCodexThreadDefault } from "../codex/thread_factory.js";
import { codexEventError, hasAttemptActivity } from "../accounts/errors.js";

export async function runWorkerJob({
  job,
  config,
  store,
  signal,
  codexClients = new Map(),
  createThread = createCodexThreadDefault,
  now = () => new Date()
} = {}) {
  if (!job?.id) throw new Error("worker job id is required.");
  await store.appendJobEvent(job.id, {
    type: "worker.job.started",
    status: "running",
    chatKey: job.chatKey,
    kind: job.kind || "user"
  });
  await store.writeJobState({
    ...job,
    status: "running",
    startedAt: job.startedAt || now().toISOString()
  });

  const streamState = createCodexStreamState();
  let thread;
  const input = Array.isArray(job.input)
    ? job.input
    : buildInput(job.inputText || job.text || "", job.imagePaths || []);
  const turnOptions = { signal };
  if (job.outputSchema) turnOptions.outputSchema = job.outputSchema;

  try {
    thread = createThread({
      transport: job.transport || config.codexTransport,
      threadId: job.threadId || "",
      accountId: job.accountId || "default",
      attemptState: job.accountAttemptState || {},
      effectiveOptions: job.effectiveOptions || {},
      config,
      codexClients
    });
    const { events } = await thread.runStreamed(input, turnOptions);
    for await (const event of events) {
      const failure = codexEventError(event);
      if (failure && !failure.willRetry) throw failure;
      if (event.type === "account.attempt.started") {
        job.accountId = event.accountId;
        job.threadId = event.threadId || "";
        job.accountAttemptState = { accountId: event.accountId, triedAccountIds: event.triedAccountIds, hadActivity: event.hadActivity === true };
        await store.writeJobState({ ...job, status: "running" });
      }
      if (hasAttemptActivity(event) && job.accountAttemptState && !job.accountAttemptState.hadActivity) {
        job.accountAttemptState.hadActivity = true;
        await store.writeJobState({ ...job, status: "running" });
      }
      const update = applyCodexStreamEvent(streamState, event);
      if (update.type === "thread_started") {
        job.threadId = update.threadId || job.threadId || "";
        await store.writeJobState({ ...job, status: "running", threadId: job.threadId });
      }
      await store.appendJobEvent(job.id, {
        ...event,
        accountId: event.accountId || job.accountId || "default",
        chatKey: job.chatKey,
        threadId: job.threadId || thread?.id || "",
        status: update.type === "turn_completed" ? "completed" : ""
      });
    }

    const result = codexStreamResult(streamState);
    await store.appendJobEvent(job.id, {
      type: "worker.job.completed",
      status: "completed",
      chatKey: job.chatKey,
      threadId: job.threadId || thread?.id || "",
      accountId: thread.accountId || job.accountId || "default",
      finalResponseLength: result.finalResponse.length,
      itemCount: result.items.length,
      usage: result.usage ?? null
    });
    await store.writeJobState({
      ...job,
      status: "completed",
      threadId: job.threadId || thread?.id || "",
      completedAt: now().toISOString()
    });
    return result;
  } catch (error) {
    const aborted = signal?.aborted === true;
    const type = aborted ? "worker.job.cancelled" : "worker.job.failed";
    const status = aborted ? "cancelled" : "failed";
    await store.appendJobEvent(job.id, {
      type,
      status,
      chatKey: job.chatKey,
      threadId: job.threadId || thread?.id || "",
      message: error instanceof Error ? error.message : String(error)
    });
    await store.writeJobState({
      ...job,
      status,
      threadId: job.threadId || thread?.id || "",
      completedAt: now().toISOString(),
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}
