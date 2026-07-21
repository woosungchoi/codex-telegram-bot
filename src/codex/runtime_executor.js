import {
  appServerThreadReadEvents,
  readAppServerThread
} from "./app_server.js";
import { analyzeContextPressure, resolveAutoCompactTokenLimit } from "./compact.js";
import { readCodexSessionBackfill } from "./session_backfill.js";
import {
  applyCodexStreamEvent,
  codexStreamItems,
  codexStreamResult,
  createCodexStreamState
} from "./stream.js";
import { CODEX_TRANSPORT_APP_SERVER_DIRECT } from "./thread_factory.js";
import { createCodexStreamWatchdog, STREAM_IDLE_TIMEOUT_MESSAGE } from "./watchdog.js";
import { startRecoveryBackfillPoller } from "../recovery/backfill_poller.js";

const STREAM_BACKFILLED_MESSAGE = "stream_backfilled";

export function createCodexRuntimeExecutor({
  settings,
  chats,
  options,
  threads,
  recovery,
  progress,
  usage,
  telegram,
  formatting,
  text: t,
  sleep,
  now = Date.now
}) {
  async function runCodexTurn(
    ctx,
    chatKey,
    thread,
    input,
    signal,
    workingMessageId,
    liveProgress = null,
    turnOptions = {}
  ) {
    const linkedAbort = createLinkedAbortController(signal);
    const codexOptions = options.build(chatKey, linkedAbort.controller.signal);
    if (!options.get(chatKey).streamEvents) {
      try {
        return await thread.run(input, codexOptions);
      } finally {
        linkedAbort.cleanup();
      }
    }

    const streamStartedAt = now();
    await recovery.recordStreamStarted(chatKey, turnOptions.turnKind || "user");
    const { events } = await thread.runStreamed(input, codexOptions);
    const streamState = createCodexStreamState();
    let lastProgressAt = 0;
    let firstItemSeen = false;
    let streamOutcome = "completed";
    const isRecoveryTurn = turnOptions.turnKind === "recovery";
    let backfillPollRecovered = false;
    const watchdog = createCodexStreamWatchdog({
      noticeMs: settings.runtimeValue("codexStreamIdleNoticeMs"),
      abortMs: settings.runtimeValue("codexStreamIdleAbortMs"),
      onNotice: ({ idleMs }) => recovery.recordIdleNotice(ctx, chatKey, idleMs, isRecoveryTurn),
      onTimeout: ({ idleMs }) => recovery.recordIdleTimeout(chatKey, idleMs),
      abort: (error) => linkedAbort.controller.abort(error)
    });
    const backfillPoller = isRecoveryTurn
      ? startCodexStreamBackfillPoller(chatKey, thread, streamState, {
        sinceMs: streamStartedAt,
        intervalMs: settings.runtimeValue("botRecoveryBackfillPollMs"),
        onRecovered: () => {
          backfillPollRecovered = true;
          streamOutcome = "backfilled_after_poll";
          linkedAbort.controller.abort(new Error(STREAM_BACKFILLED_MESSAGE));
        }
      })
      : null;
    watchdog.start();

    try {
      for await (const event of events) {
        watchdog.touch();
        const update = applyCodexStreamEvent(streamState, event);
        if (update.type === "thread_started") {
          if (turnOptions.rememberThreadId !== false) {
            const chat = chats.get(chatKey);
            chat.threadId = update.threadId;
            await chats.save();
            await recovery.recordThreadStarted(chatKey, update.threadId);
          }
        } else if (update.type === "item") {
          await recovery.recordStreamItem(chatKey, event, update);
          if (!firstItemSeen) {
            firstItemSeen = true;
            await recovery.recordFirstItem(chatKey, event, update, now() - streamStartedAt);
          }
          if (update.finalResponseChanged) {
            await recovery.recordFinalResponse(
              chatKey,
              streamState.finalResponse.length,
              now() - streamStartedAt
            );
          }
          const currentTime = now();
          if (
            workingMessageId
            && currentTime - lastProgressAt > settings.runtimeValue("progressEditIntervalMs")
          ) {
            lastProgressAt = currentTime;
            await progress.editMessage(
              ctx,
              workingMessageId,
              progress.summarize(codexStreamItems(streamState))
            );
          }
        } else if (update.type === "error") {
          streamOutcome = "error";
          await recovery.recordActiveTurnFailed(chatKey, update.message);
          throw new Error(update.message);
        } else if (update.type === "turn_completed") {
          await recovery.appendEvent({ type: "turn_completed", chatKey });
        } else if (update.type === "unknown") {
          await recovery.recordUnknownEvent(chatKey, event, now() - streamStartedAt);
        }
        await progress.maybeSend(ctx, liveProgress, event, codexStreamItems(streamState));
      }

      return codexStreamResult(streamState);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (backfillPollRecovered || message === STREAM_BACKFILLED_MESSAGE) {
        streamOutcome = "backfilled_after_poll";
        return codexStreamResult(streamState);
      }
      streamOutcome = watchdog.timeoutTriggered ? STREAM_IDLE_TIMEOUT_MESSAGE : "error";
      if (watchdog.timeoutTriggered) {
        if (await tryBackfillCompletedStream(chatKey, thread, streamState, {
          sinceMs: streamStartedAt,
          reason: "stream_idle_timeout"
        })) {
          streamOutcome = "backfilled_after_idle_timeout";
          return codexStreamResult(streamState);
        }
        throw new Error(STREAM_IDLE_TIMEOUT_MESSAGE);
      }
      throw error;
    } finally {
      backfillPoller?.stop();
      watchdog.stop();
      linkedAbort.cleanup();
      await recovery.recordIteratorClosed(chatKey, {
        elapsedMs: now() - streamStartedAt,
        outcome: streamOutcome,
        itemCount: codexStreamItems(streamState).length,
        finalResponseLength: streamState.finalResponse.length
      });
    }
  }

  function startCodexStreamBackfillPoller(
    chatKey,
    thread,
    streamState,
    { sinceMs = 0, intervalMs = 0, onRecovered = () => {} } = {}
  ) {
    if (!settings.recoveryEnabled) return null;
    if (!Number.isFinite(Number(intervalMs)) || Number(intervalMs) <= 0) return null;
    return startRecoveryBackfillPoller({
      intervalMs,
      check: async () => {
        const backfillState = createCodexStreamState();
        const recovered = await tryBackfillCompletedStream(chatKey, thread, backfillState, {
          sinceMs,
          reason: "recovery_backfill_poll",
          recordMiss: false
        });
        if (recovered) copyCodexStreamState(streamState, backfillState);
        return recovered;
      },
      onRecovered,
      onError: (error, { reason } = {}) => recovery.appendEvent({
        type: "recovery_backfill_poll_error",
        chatKey,
        threadId: thread?.id || chats.get(chatKey).threadId || "",
        reason: reason || "interval",
        message: formatting.truncate(error instanceof Error ? error.message : String(error), 500)
      })
    });
  }

  async function tryBackfillCompletedStream(
    chatKey,
    thread,
    streamState,
    { sinceMs = 0, reason = "manual", recordMiss = true } = {}
  ) {
    const threadId = thread?.id || chats.get(chatKey).threadId || "";
    if (!threadId) return false;
    let events = [];
    try {
      events = await readBackfillEventsForThread(thread, threadId, { sinceMs });
    } catch (error) {
      await recovery.recordBackfill(chatKey, {
        threadId,
        reason,
        recovered: false,
        eventCount: 0,
        finalResponseLength: streamState.finalResponse.length,
        source: threads.transport(thread),
        status: error instanceof Error ? error.message : String(error)
      });
      return false;
    }
    if (events.length === 0) return false;

    let completed = false;
    let failed = false;
    for (const event of events) {
      const update = applyCodexStreamEvent(streamState, event);
      if (update.type === "turn_completed") completed = true;
      if (update.type === "error") failed = true;
    }
    const recovered = completed && !failed && Boolean(streamState.finalResponse);
    if (recovered || recordMiss) {
      await recovery.recordBackfill(chatKey, {
        threadId,
        reason,
        recovered,
        eventCount: events.length,
        finalResponseLength: streamState.finalResponse.length,
        source: threads.transport(thread)
      });
    }
    if (recovered) {
      await recovery.appendEvent({ type: "turn_completed", chatKey, threadId, source: "backfill" });
    }
    return recovered;
  }

  async function readBackfillEventsForThread(thread, threadId, { sinceMs = 0 } = {}) {
    if (
      threads.transport(thread) === CODEX_TRANSPORT_APP_SERVER_DIRECT
      || threads.currentTransport() === CODEX_TRANSPORT_APP_SERVER_DIRECT
    ) {
      const response = await readAppServerThread({
        threadId,
        codexPath: settings.codexPath,
        codexEnv: settings.codexEnv,
        connectTimeoutMs: settings.runtimeValue("codexAppServerDirectTimeoutMs"),
        includeTurns: true
      });
      return appServerThreadReadEvents(response, { threadId });
    }
    const backfill = await readCodexSessionBackfill({
      sessionsDir: settings.sessionsDir,
      threadId,
      sinceMs
    });
    return backfill.events;
  }

  async function refreshUsageSample(chatKey, signal) {
    const thread = threads.start(chatKey);
    await thread.run("Reply exactly: OK.", { signal });
    if (!thread.id) throw new Error("Usage refresh did not create a Codex thread id.");

    const sample = await waitForLatestTokenCount(thread.id);
    if (!sample) throw new Error("Codex usage sample was not written for the refresh turn.");

    const chat = chats.get(chatKey);
    chat.usageProbeThreadId = thread.id;
    chat.updatedAt = new Date(now()).toISOString();
    await chats.save();
    return sample;
  }

  async function waitForLatestTokenCount(threadId) {
    const deadline = now() + 8000;
    while (now() < deadline) {
      const sample = await usage.readLatestTokenCount(threadId);
      if (sample) return sample;
      await sleep(250);
    }
    return null;
  }

  async function maybeNotifyContextPressure(ctx, chatKey, thread) {
    if (!settings.contextGuardEnabled) return;
    const threadId = thread?.id || chats.get(chatKey).threadId;
    if (!threadId) return;
    const sample = await usage.readLatestTokenCount(threadId);
    const pressure = analyzeContextPressure(sample?.tokenCount);
    if (!pressure) return;

    const threshold = settings.contextCompactThresholdPercent;
    const overPercent = threshold > 0 && pressure.percent >= threshold;
    const lowRemaining = settings.contextMinRemainingTokens > 0
      && pressure.remainingTokens <= settings.contextMinRemainingTokens;
    if (!overPercent && !lowRemaining) return;

    const autoLimit = resolveAutoCompactTokenLimit(settings.config);
    await telegram.replyHtml(ctx, formatting.keyValue(t("contextCompactContinueTitle"), [
      [
        t("contextUsage"),
        `${Math.round(pressure.percent)}% (${pressure.inputTokens}/${pressure.modelContextWindow})`
      ],
      [t("contextRemaining"), pressure.remainingTokens],
      [t("contextAutoCompact"), autoLimit > 0 ? autoLimit : t("contextAutoCompactDefault")],
      [t("contextAction"), t("contextCompactContinueAction")]
    ]));
  }

  return {
    maybeNotifyContextPressure,
    refreshUsageSample,
    runCodexTurn,
    tryBackfillCompletedStream
  };
}

function copyCodexStreamState(target, source) {
  target.items = source.items;
  target.appServerAgentMessageTextById = source.appServerAgentMessageTextById;
  target.nextSyntheticItemId = source.nextSyntheticItemId;
  target.finalResponse = source.finalResponse;
  target.usage = source.usage;
}

function createLinkedAbortController(parentSignal) {
  const controller = new AbortController();
  if (!parentSignal) return { controller, cleanup: () => {} };
  if (parentSignal.aborted) {
    controller.abort(parentSignal.reason);
    return { controller, cleanup: () => {} };
  }
  const abort = () => controller.abort(parentSignal.reason);
  parentSignal.addEventListener("abort", abort, { once: true });
  return {
    controller,
    cleanup: () => parentSignal.removeEventListener("abort", abort)
  };
}
