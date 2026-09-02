import {
  applyCodexStreamEvent,
  codexStreamItems,
  codexStreamResult,
  createCodexStreamState
} from "../codex/stream.js";
import { createRecoveryTurn } from "../recovery/startup.js";
import { upsertActiveTurnSnapshot } from "../recovery/state.js";
import {
  markWorkerDeliveryStreaming,
  mergeWorkerDeliveryCursor,
  normalizeWorkerDeliveryEntry,
  workerDeliveryKey
} from "./delivery.js";
import {
  isTerminalWorkerEvent,
  isTerminalWorkerStatus,
  isWorkerRestartFailure,
  WORKER_RESTART_FAILURE_REASON
} from "./replay.js";

const RETRYABLE_WORKER_TRANSPORT_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOENT",
  "EPIPE",
  "ETIMEDOUT"
]);

export function createWorkerRuntimeController({
  settings,
  deliveryStore,
  chatStore,
  worker,
  turn,
  recovery,
  sleep,
  logger = console,
  now = () => new Date(),
  nowMs = Date.now
}) {
  function createWorkerJobPayload(chatKey, preparedTurn) {
    const chat = chatStore.get(chatKey);
    const effectiveOptions = chatStore.getEffectiveOptions(chatKey);
    return {
      id: preparedTurn.id || turn.createQueueItemId(),
      chatKey,
      chatId: preparedTurn.chatId ?? chatKey,
      chatType: preparedTurn.chatType,
      messageThreadId: preparedTurn.messageThreadId,
      replyToMessageId: preparedTurn.replyToMessageId,
      originMessageId: preparedTurn.originMessageId,
      originUpdateId: preparedTurn.originUpdateId,
      kind: preparedTurn.kind || "user",
      text: preparedTurn.text || "",
      inputText: preparedTurn.inputText || preparedTurn.text || "",
      imagePaths: preparedTurn.imagePaths || [],
      threadId: preparedTurn.recovery?.threadId || chat.threadId || "",
      effectiveOptions,
      outputSchema: chat.outputSchema || null,
      transport: worker.transport(),
      enqueuedAt: preparedTurn.enqueuedAt || now().toISOString(),
      recovery: preparedTurn.recovery || null
    };
  }

  async function processPreparedTurnViaWorker(
    ctx,
    chatKey,
    preparedTurn,
    active,
    liveProgress
  ) {
    const client = worker.getClient();
    let currentTurn = preparedTurn;
    let restartAttempt = 0;
    const restartAttemptLimit = Math.max(
      0,
      Number(settings.workerRestartRecoveryAttempts ?? 3) || 0
    );
    const initialJob = createWorkerJobPayload(chatKey, preparedTurn);
    try {
      await turn.maybeNotifyContextPressure(ctx, chatKey, { id: initialJob.threadId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("worker context pressure check failed; continuing with job:", message);
    }

    while (true) {
      const job = restartAttempt === 0 ? initialJob : createWorkerJobPayload(chatKey, currentTurn);
      active.workerCancelRequested = false;
      const started = await client.startJob(job);
      active.workerJobId = started.jobId;
      active.workerEventSeq = workerDeliveryCursor(chatKey, started.jobId);
      await recordWorkerJobStarted(chatKey, { ...job, id: started.jobId });

      const cancelWorker = () => cancelWorkerJobOnce(active, started.jobId);
      if (active.abortController.signal.aborted) cancelWorker();
      else active.abortController.signal.addEventListener("abort", cancelWorker, { once: true });

      try {
        const result = await waitForWorkerJob(
          ctx,
          chatKey,
          started.jobId,
          active,
          liveProgress,
          { turnKind: currentTurn.kind || "user" }
        );
        return { ...result, executionMode: "sidecar", workerJobId: started.jobId };
      } catch (error) {
        if (
          settings.recoveryEnabled !== true
          || active.abortController.signal.aborted
          || !isWorkerRestartFailure(error)
          || restartAttempt >= restartAttemptLimit
        ) throw error;

        restartAttempt += 1;
        currentTurn = createWorkerRestartRecoveryTurn(
          chatKey,
          currentTurn,
          started.jobId,
          restartAttempt
        );
        active.currentPreparedTurn = currentTurn;
        active.currentQueueItemId = currentTurn.id;
        active.currentText = currentTurn.text;
        await recovery.appendEvent({
          type: "worker_restart_recovery_started",
          chatKey,
          jobId: started.jobId,
          nextJobId: currentTurn.id,
          threadId: currentTurn.recovery?.threadId || "",
          attempt: restartAttempt,
          attemptLimit: restartAttemptLimit
        });
        logger.warn(
          `worker restarted during ${started.jobId}; continuing as ${currentTurn.id} `
          + `(${restartAttempt}/${restartAttemptLimit})`
        );
      } finally {
        active.abortController.signal.removeEventListener("abort", cancelWorker);
      }
    }
  }

  function createWorkerRestartRecoveryTurn(chatKey, preparedTurn, workerJobId, attempt) {
    const chat = chatStore.get(chatKey);
    const priorRecovery = preparedTurn.recovery || {};
    const inputPreview = compactRecoveryPreview(
      priorRecovery.inputPreview || preparedTurn.text || preparedTurn.inputText || ""
    );
    const candidate = {
      chatKey,
      chatId: preparedTurn.chatId ?? chatKey,
      messageThreadId: preparedTurn.messageThreadId,
      replyToMessageId: preparedTurn.replyToMessageId,
      originMessageId: preparedTurn.originMessageId,
      originUpdateId: preparedTurn.originUpdateId,
      queueItemId: priorRecovery.queueItemId || preparedTurn.id || workerJobId,
      threadId: chat.threadId || priorRecovery.threadId || "",
      reason: WORKER_RESTART_FAILURE_REASON,
      attempt,
      inputPreview,
      startedAt: priorRecovery.startedAt || preparedTurn.enqueuedAt || "",
      lastEventAt: now().toISOString(),
      workerJobId
    };
    const recoveryTurn = createRecoveryTurn(candidate, {
      restartId: `worker-${turn.createQueueItemId()}`,
      workingDirectory: settings.workingDirectory,
      serviceName: "codex-telegram-worker.service",
      restartSubject: "codex-telegram-worker",
      now: now()
    });
    recoveryTurn.recovery = {
      ...recoveryTurn.recovery,
      attempt,
      inputPreview,
      queueItemId: candidate.queueItemId,
      workerJobId
    };
    return recoveryTurn;
  }

  async function waitForWorkerJob(ctx, chatKey, jobId, active, liveProgress, options = {}) {
    const client = worker.getClient();
    const streamStartedAt = nowMs();
    const streamState = createCodexStreamState();
    const progressState = liveProgress;
    let cursor = Number.isFinite(Number(options.afterSeq))
      ? Number(options.afterSeq)
      : workerDeliveryCursor(chatKey, jobId);
    let firstItemSeen = false;
    let terminal = null;
    let threadId = chatStore.get(chatKey).threadId || "";
    let streamOutcome = "completed";
    let pollFailureCount = 0;
    await turn.recordCodexStreamStarted(chatKey, options.turnKind || "user");

    try {
      while (!terminal) {
        if (active.abortController?.signal?.aborted) {
          cancelWorkerJobOnce(active, jobId);
        }

        let response;
        try {
          response = await client.readJobEvents(jobId, cursor);
          pollFailureCount = 0;
        } catch (error) {
          if (!isRetryableWorkerPollError(error)) throw error;
          pollFailureCount += 1;
          if (pollFailureCount === 1 || pollFailureCount % 10 === 0) {
            logger.warn(
              `worker event polling retry (${pollFailureCount}) for ${jobId}:`,
              error instanceof Error ? error.message : String(error)
            );
          }
          await sleep(settings.eventPollMs());
          continue;
        }
        const events = response.events || [];
        if (events.length === 0) {
          const status = await client.getJobStatus(jobId).catch(() => null);
          const job = status?.job || null;
          if (isTerminalWorkerStatus(job?.status)) {
            if (cursor > 0 && codexStreamItems(streamState).length === 0) {
              cursor = 0;
              continue;
            }
            terminal = {
              type: `worker.job.${job.status}`,
              status: job.status,
              reason: job.failureReason || "",
              message: job.error || ""
            };
            break;
          }
          await sleep(settings.eventPollMs());
          continue;
        }

        for (const event of events) {
          const seq = Number(event.seq || cursor);
          cursor = Number.isFinite(seq) ? Math.max(cursor, seq) : cursor;
          active.workerEventSeq = cursor;
          await recordWorkerDeliveryCursor(chatKey, jobId, cursor);

          const eventType = String(event.type || "");
          if (event.threadId) threadId = event.threadId;
          if (eventType.startsWith("worker.job.")) {
            if (isTerminalWorkerEvent(event)) terminal = event;
            continue;
          }

          const update = applyCodexStreamEvent(streamState, event);
          if (update.type === "thread_started") {
            threadId = update.threadId || threadId;
            const chat = chatStore.get(chatKey);
            chat.threadId = threadId;
            chat.updatedAt = now().toISOString();
            await deliveryStore.save();
            await turn.recordThreadStarted(chatKey, threadId);
          } else if (update.type === "item") {
            await turn.recordStreamItemEvent(chatKey, event, update);
            if (!firstItemSeen) {
              firstItemSeen = true;
              await turn.recordCodexStreamFirstItem(
                chatKey,
                event,
                update,
                nowMs() - streamStartedAt
              );
            }
            if (update.finalResponseChanged) {
              await turn.recordCodexStreamFinalResponseSeen(
                chatKey,
                streamState.finalResponse.length,
                nowMs() - streamStartedAt
              );
            }
          } else if (update.type === "error") {
            streamOutcome = "error";
            await turn.recordActiveTurnFailed(chatKey, update.message);
            throw new Error(update.message);
          } else if (update.type === "turn_completed") {
            await recovery.appendEvent({ type: "turn_completed", chatKey, threadId });
          } else if (update.type === "unknown") {
            await turn.recordCodexStreamUnknownEvent(
              chatKey,
              event,
              nowMs() - streamStartedAt
            );
          }
          await turn.maybeSendLiveProgress(
            ctx,
            progressState,
            event,
            codexStreamItems(streamState)
          );
        }
      }

      if (terminal?.type === "worker.job.failed") {
        streamOutcome = "error";
        const error = new Error(terminal.message || "Codex worker job failed.");
        if (terminal.reason) error.code = terminal.reason;
        throw error;
      }
      if (terminal?.type === "worker.job.cancelled") {
        streamOutcome = "cancelled";
        throw new Error(terminal.message || "Codex worker job was cancelled.");
      }
      return { turn: codexStreamResult(streamState), threadId, workerLastSeq: cursor };
    } finally {
      await turn.recordCodexStreamIteratorClosed(chatKey, {
        elapsedMs: nowMs() - streamStartedAt,
        outcome: streamOutcome,
        itemCount: codexStreamItems(streamState).length,
        finalResponseLength: streamState.finalResponse.length
      });
    }
  }

  function workerDeliveryCursor(chatKey, jobId) {
    const key = workerDeliveryKey(chatKey, jobId);
    const entry = normalizeWorkerDeliveryEntry(key, deliveryStore.get(key));
    return Number(entry?.seq || 0);
  }

  async function recordWorkerDeliveryCursor(chatKey, jobId, seq) {
    const key = workerDeliveryKey(chatKey, jobId);
    const current = normalizeWorkerDeliveryEntry(key, deliveryStore.get(key));
    deliveryStore.set(
      key,
      current
        ? mergeWorkerDeliveryCursor(current, { chatKey, jobId, seq })
        : markWorkerDeliveryStreaming(null, { chatKey, jobId, seq })
    );
    await deliveryStore.save();
    if (!settings.recoveryEnabled) return;
    await recovery.write(async () => {
      await upsertActiveTurnSnapshot(settings.recoveryDir, chatKey, {
        workerJobId: jobId,
        workerEventSeq: Number(seq || 0),
        lastEventAt: now().toISOString(),
        lastKnownStatus: "worker_event_delivered"
      });
    });
  }

  function cancelWorkerJobOnce(active, jobId) {
    if (!active || !jobId || active.workerCancelRequested) return;
    active.workerCancelRequested = true;
    worker.getClient().cancelJob(jobId).catch((error) => {
      logger.warn("worker cancel failed:", error instanceof Error ? error.message : String(error));
    });
  }

  async function recordWorkerJobStarted(chatKey, job) {
    const timestamp = now().toISOString();
    const chat = chatStore.get(chatKey);
    if (job.threadId) {
      chat.threadId = job.threadId;
      chat.updatedAt = timestamp;
    }
    const deliveryKey = workerDeliveryKey(chatKey, job.id || "");
    const currentDelivery = normalizeWorkerDeliveryEntry(
      deliveryKey,
      deliveryStore.get(deliveryKey)
    );
    deliveryStore.set(
      deliveryKey,
      markWorkerDeliveryStreaming(currentDelivery, {
        chatKey,
        jobId: job.id || "",
        seq: currentDelivery?.seq || 0
      })
    );
    await deliveryStore.save();
    if (!settings.recoveryEnabled) return;
    await recovery.write(async () => {
      await upsertActiveTurnSnapshot(settings.recoveryDir, chatKey, {
        threadId: job.threadId || chat.threadId || "",
        workerJobId: job.id || "",
        workerEventSeq: workerDeliveryCursor(chatKey, job.id || ""),
        workerMode: worker.mode(),
        workerTransport: job.transport || worker.transport(),
        lastEventAt: timestamp,
        lastKnownStatus: "worker_job_started"
      });
      await recovery.appendEvent({
        type: "worker_job_started",
        chatKey,
        jobId: job.id || "",
        threadId: job.threadId || chat.threadId || "",
        transport: job.transport || worker.transport()
      });
    });
  }

  return {
    cancelWorkerJobOnce,
    createWorkerJobPayload,
    processPreparedTurnViaWorker,
    waitForWorkerJob,
    workerDeliveryCursor
  };
}

function isRetryableWorkerPollError(error) {
  const code = String(error?.code ?? error?.cause?.code ?? "").toUpperCase();
  if (RETRYABLE_WORKER_TRANSPORT_CODES.has(code)) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /^worker (?:request timed out|connection closed): job\/events\b/i.test(message);
}

function compactRecoveryPreview(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 240);
}
