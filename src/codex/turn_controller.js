import { errorText, createMessageFormatter } from "../i18n.js";
import { buildInput, mergeReplyContext } from "./input.js";
import { isStreamIdleTimeout, STREAM_IDLE_TIMEOUT_MESSAGE } from "./watchdog.js";
import { runTelegramFinalDelivery, summarizeTelegramError } from "../telegram/api.js";
import { b, code } from "../telegram/html.js";
import { planIncomingTurn } from "../queue.js";

function isCodexBadRequest(message) {
  const normalized = String(message ?? "").trim();
  if (normalized.toLowerCase() === "bad request") return true;
  try {
    return JSON.parse(normalized)?.detail === "Bad Request";
  } catch {
    return false;
  }
}

export function createTurnRuntimeController({
  settings,
  activeTurns,
  queue,
  lifecycle,
  context,
  codex,
  worker,
  recovery,
  progress,
  telegram,
  status,
  sideTurns,
  text: t,
  logger = console,
  now = () => new Date(),
  timers = { setInterval, clearInterval }
}) {
  const msg = createMessageFormatter(t);
  function formatCodexFailure(title, message) {
    const lines = [b(title), code(message)];
    if (isCodexBadRequest(message)) {
      lines.push("", t("codexBadRequestRecoveryDetail"));
    }
    return lines.join("\n");
  }

  async function handleCodexMessage(ctx, text, loadImages) {
    const chatKey = context.getChatKey(ctx);
    await queue.pruneExpired(chatKey, ctx);
    const pendingDelivery = queue.hasPendingFinalDelivery(chatKey);
    if (
      status.isStatusQuestion(text)
      && (
        activeTurns.has(chatKey)
        || pendingDelivery
        || queue.getPending(chatKey).length > 0
      )
    ) {
      await telegram.replyHtml(
        ctx,
        status.formatStatusHtml(chatKey, await status.buildStatusDetails(chatKey))
      );
      return;
    }
    if (lifecycle.isRestartScheduled() || lifecycle.isRecoveryActive(chatKey)) {
      await handleSafeQueuedMessage(ctx, chatKey, text, loadImages);
      return;
    }

    const incomingPlan = planIncomingTurn({
      active: activeTurns.has(chatKey),
      pendingDelivery,
      paused: queue.isPaused(chatKey),
      pendingCount: queue.getPending(chatKey).length,
      queueMode: queue.getMode(chatKey)
    });
    if (incomingPlan === "enqueue_front_interrupt") {
      await handleInterruptMessage(ctx, chatKey, text, loadImages);
      return;
    }
    if (incomingPlan === "start_side") {
      await handleSideMessage(ctx, chatKey, text, loadImages);
      return;
    }
    if (incomingPlan === "enqueue_back") {
      await handleSafeQueuedMessage(ctx, chatKey, text, loadImages);
      return;
    }

    const active = { abortController: null, stopRequested: false };
    activeTurns.set(chatKey, active);
    try {
      const preparedTurn = await prepareCodexTurn(ctx, text, loadImages);
      if (active.interruptBeforeStart) {
        const nextTurn = await queue.dequeue(chatKey, ctx);
        if (nextTurn) startPreparedTurnQueueInBackground(chatKey, nextTurn, active);
        else activeTurns.delete(chatKey);
        return;
      }
      startPreparedTurnQueueInBackground(chatKey, preparedTurn, active);
    } catch (error) {
      await telegram.replyHtml(
        ctx,
        msg("ui.prepareInputFailed", { value1: code(errorText(error, t)) })
      );
      const nextTurn = await queue.dequeue(chatKey, ctx);
      if (nextTurn) startPreparedTurnQueueInBackground(chatKey, nextTurn, active);
      else activeTurns.delete(chatKey);
    }
  }

  async function handleSafeQueuedMessage(ctx, chatKey, text, loadImages) {
    let preparedTurn;
    try {
      preparedTurn = await prepareCodexTurn(ctx, text, loadImages);
    } catch (error) {
      await telegram.replyHtml(
        ctx,
        msg("ui.prepareInputFailed", { value1: code(errorText(error, t)) })
      );
      return;
    }
    const queued = await queue.enqueue(chatKey, preparedTurn);
    if (!queued.ok) {
      await telegram.replyHtml(
        ctx,
        msg("ui.maxQueuedTurnsUseOrLine", { value1: b(msg("ui.codexQueueIsFull")), value2: code(settings.maxPendingTurns()), value3: code("/queue"), value4: code("/cancelqueue") })
      );
      return;
    }
    const paused = queue.isPaused(chatKey)
      ? t("ui.queuePausedNotice")
      : "";
    await telegram.replyHtml(
      ctx,
      msg("ui.queuedCodexTurnUseToInspectOrToLine", { value1: code(`#${queued.position}`), value2: paused, value3: code("/queue"), value4: code("/cancelqueue") })
    );
  }

  async function handleInterruptMessage(ctx, chatKey, text, loadImages) {
    let preparedTurn;
    try {
      preparedTurn = await prepareCodexTurn(ctx, text, loadImages);
    } catch (error) {
      await telegram.replyHtml(
        ctx,
        msg("ui.prepareInputFailed", { value1: code(errorText(error, t)) })
      );
      return;
    }

    const active = activeTurns.get(chatKey);
    if (!active) {
      await startPreparedTurnQueue(chatKey, preparedTurn);
      return;
    }

    const queued = await queue.enqueueFront(chatKey, preparedTurn);
    if (!queued.ok) {
      await telegram.replyHtml(
        ctx,
        msg("ui.maxQueuedTurnsUseOrLine", { value1: b(msg("ui.codexQueueIsFull")), value2: code(settings.maxPendingTurns()), value3: code("/queue"), value4: code("/cancelqueue") })
      );
      return;
    }

    active.interruptRequested = true;
    if (active.abortController) active.abortController.abort();
    else active.interruptBeforeStart = true;
    await telegram.replyHtml(
      ctx,
      `${b(t("interruptRequestedTitle"))}\n${t("interruptRequestedDetail")}`
    );
  }

  async function handleSideMessage(ctx, chatKey, text, loadImages) {
    let preparedTurn;
    try {
      preparedTurn = await prepareCodexTurn(ctx, text, loadImages);
    } catch (error) {
      await telegram.replyHtml(
        ctx,
        msg("ui.prepareSideInputFailed", { value1: code(errorText(error, t)) })
      );
      return;
    }

    processSideTurn(chatKey, preparedTurn).catch(async (error) => {
      await telegram.replyHtml(
        ctx,
        msg("ui.sideTurnFailed", { value1: code(errorText(error, t)) })
      ).catch(() => {});
    });
    await telegram.replyHtml(
      ctx,
      `${b(t("sideTurnStartedTitle"))}\n${t("sideTurnStartedDetail")}`
    );
  }

  async function startPreparedTurnQueue(chatKey, preparedTurn) {
    const active = { abortController: null, stopRequested: false };
    activeTurns.set(chatKey, active);
    startPreparedTurnQueueInBackground(chatKey, preparedTurn, active);
  }

  function startPreparedTurnQueueInBackground(chatKey, preparedTurn, active) {
    runPreparedTurnQueue(chatKey, preparedTurn, active).catch(async (error) => {
      activeTurns.delete(chatKey);
      const ctx = context.ensureTurnContext(preparedTurn);
      await telegram.replyHtml(
        ctx,
        msg("ui.queuedTurnFailedDetail", { value1: code(errorText(error, t)) })
      ).catch(() => {});
    });
  }

  async function processSideTurn(chatKey, preparedTurn) {
    const ctx = context.ensureTurnContext(preparedTurn);
    const abortController = new AbortController();
    sideTurns.track(chatKey, abortController);
    let finalReaction = "";
    await telegram.reactQuietly(ctx, settings.thinkingReaction);
    const typingInterval = timers.setInterval(() => {
      ctx.sendChatAction("typing").catch(() => {});
    }, 4500);

    try {
      const input = buildInput(
        applySideThreadPrompt(preparedTurn.inputText),
        preparedTurn.imagePaths
      );
      const thread = codex.startThread(chatKey);
      const turn = await codex.runTurn(
        ctx,
        chatKey,
        thread,
        input,
        abortController.signal,
        undefined,
        null,
        { rememberThreadId: false }
      );
      const response = codex.formatTurn(turn);
      await telegram.replyHtml(ctx, b(msg("ui.sideReply")));
      await telegram.replyCodexAnswer(
        ctx,
        response || t("ui.sideCompletedWithoutMessage")
      );
      finalReaction = settings.completeReaction;
    } catch (error) {
      const message = errorText(error, t);
      finalReaction = abortController.signal.aborted
        ? settings.stoppedReaction
        : settings.errorReaction;
      await telegram.replyHtml(ctx, formatCodexFailure(msg("ui.sideCodexFailed"), message));
    } finally {
      timers.clearInterval(typingInterval);
      sideTurns.untrack(chatKey, abortController);
      await telegram.reactQuietly(
        ctx,
        finalReaction,
        finalReaction === settings.completeReaction
      );
    }
  }

  function applySideThreadPrompt(inputText) {
    return [
      "This is a side reply while the main Telegram Codex turn continues.",
      "Answer the user directly. Avoid file changes or write commands; if the request requires changing files, say it should be queued in safe mode instead.",
      "",
      inputText
    ].join("\n");
  }

  async function prepareCodexTurn(ctx, text, loadImages) {
    const replyContext = await context.buildReplyContext(ctx);
    const imagePaths = [...replyContext.imagePaths, ...await loadImages()];
    const inputText = context.applyPersonaPrompt(mergeReplyContext(text, replyContext));
    const enqueuedAt = now();
    const messageMeta = context.telegramMessageMeta(ctx);
    return {
      id: queue.createItemId(),
      ctx,
      chatKey: context.getChatKey(ctx),
      chatId: ctx.chat?.id ?? ctx.from?.id,
      ...messageMeta,
      kind: "user",
      text,
      inputText,
      imagePaths,
      enqueuedAt: enqueuedAt.toISOString(),
      expiresAt: new Date(
        enqueuedAt.getTime() + settings.pendingTurnMaxAgeSeconds() * 1000
      ).toISOString()
    };
  }

  async function runPreparedTurnQueue(chatKey, firstTurn, active) {
    let nextTurn = firstTurn;
    while (nextTurn) {
      active.interruptBeforeStart = false;
      active.abortController = new AbortController();
      await processPreparedTurn(chatKey, nextTurn, active);
      if (active.stopRequested) break;
      if (queue.isPaused(chatKey)) break;
      nextTurn = await queue.dequeue(chatKey, nextTurn.ctx);
    }

    activeTurns.delete(chatKey);
  }

  async function processPreparedTurn(chatKey, preparedTurn, active) {
    const startedAt = now();
    let finalReaction = "";
    const ctx = context.ensureTurnContext(preparedTurn);
    active.currentTurnStartedAt = startedAt.toISOString();
    active.currentText = preparedTurn.text;
    active.currentQueueItemId = preparedTurn.id || "";
    active.lastProgress = "";
    active.lastProgressAt = "";
    active.currentPreparedTurn = preparedTurn;
    active.recoveryEligible = true;
    const liveProgress = progress.createState(active, chatKey);
    liveProgress.chatKey = chatKey;
    let deliveryCompleted = false;
    let completedThreadId = "";
    await recovery.restoreThreadForTurn(chatKey, preparedTurn);
    await recovery.recordActiveTurnStarted(chatKey, preparedTurn);
    await telegram.reactQuietly(ctx, settings.thinkingReaction);
    const typingInterval = timers.setInterval(() => {
      ctx.sendChatAction("typing").catch(() => {});
    }, 4500);

    try {
      let execution;
      try {
        await lifecycle.beforeTurn?.(chatKey, preparedTurn);
        execution = worker.enabled()
          ? await worker.processPreparedTurn(ctx, chatKey, preparedTurn, active, liveProgress)
          : await processPreparedTurnInline(ctx, chatKey, preparedTurn, active, liveProgress);
        await lifecycle.beforeDelivery?.(chatKey, preparedTurn);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        finalReaction = active.abortController?.signal?.aborted
          ? settings.stoppedReaction
          : settings.errorReaction;
        if (error?.suppressTelegramReply) {
          await recovery.recordActiveTurnFailed(chatKey, message);
        } else if (active.interruptRequested && active.abortController?.signal?.aborted) {
          await telegram.replyHtml(
            ctx,
            `${b(t("codexTurnInterruptedTitle"))}\n${t("codexTurnInterruptedDetail")}`
          );
          active.interruptRequested = false;
        } else if (preparedTurn.kind === "recovery" && isStreamIdleTimeout(error)) {
          await recovery.recordActiveTurnFailed(chatKey, STREAM_IDLE_TIMEOUT_MESSAGE);
          await telegram.replyHtml(
            ctx,
            `${b(t("recoveryStreamIdleTimeoutTitle"))}\n${t("recoveryStreamIdleTimeoutDetail")}`
          );
        } else {
          await recovery.recordActiveTurnFailed(chatKey, message);
          await telegram.replyHtml(ctx, formatCodexFailure(msg("ui.codexFailed"), errorText(error, t)));
        }
        return;
      }

      const response = codex.formatTurn(execution.turn);
      const replyText = response || t("ui.completedWithoutMessage");
      const delivery = await runTelegramFinalDelivery({
        onReady: () => recovery.recordTelegramReplyReady(chatKey, execution, replyText),
        onStarted: () => recovery.recordTelegramReplyStarted(chatKey, execution, replyText),
        send: () => telegram.replyCodexAnswer(ctx, replyText),
        onCompleted: () => recovery.recordTelegramReplyCompleted(chatKey, execution, replyText),
        onFailed: (error, deliveryContext) => recovery.recordTelegramReplyFailed(
          chatKey,
          execution,
          error,
          { ambiguous: deliveryContext.requestStarted }
        )
      });
      if (!delivery.ok) {
        active.stopRequested = true;
        active.deliveryPending = true;
        if (delivery.recordError) {
          logger.warn(
            "Telegram final delivery failure could not be recorded:",
            summarizeTelegramError(delivery.recordError)
          );
        }
        logger.warn("Telegram final reply delivery failed:", delivery.errorSummary);
        return;
      }

      completedThreadId = execution.threadId || codex.getChatThreadId(chatKey) || "";
      deliveryCompleted = true;
      finalReaction = settings.completeReaction;
    } finally {
      if (progress.shouldDelete(liveProgress, deliveryCompleted)) {
        await progress.deleteMessages(ctx, liveProgress);
      }
      if (deliveryCompleted) await recovery.recordActiveTurnCompleted(chatKey, completedThreadId);
      try {
        await lifecycle.onTurnFinished?.(chatKey, preparedTurn, {
          delivered: deliveryCompleted, threadId: completedThreadId,
          cancelled: active.abortController?.signal?.aborted === true,
          deliveryPending: active.deliveryPending === true
        });
      } catch (error) { logger.warn("Turn completion observer failed:", error.message); }
      timers.clearInterval(typingInterval);
      await telegram.reactQuietly(
        ctx,
        finalReaction,
        finalReaction === settings.completeReaction
      );
    }
  }

  async function processPreparedTurnInline(ctx, chatKey, preparedTurn, active, liveProgress) {
    const input = buildInput(preparedTurn.inputText, preparedTurn.imagePaths);
    const threadContext = preparedTurn.kind === "scheduled"
      ? { ...preparedTurn.recovery, accountId: preparedTurn.accountId, threadId: preparedTurn.recovery?.threadId || "" }
      : preparedTurn.recovery || (preparedTurn.kind === "forum" ? {
        accountId: preparedTurn.accountId,
        threadId: codex.getChatThreadId(chatKey, preparedTurn.accountId) || ""
      } : undefined);
    const thread = codex.getOrCreateThread(chatKey, threadContext);
    await codex.maybeNotifyContextPressure(ctx, chatKey, thread, liveProgress);
    const turn = await codex.runTurn(
      ctx,
      chatKey,
      thread,
      input,
      active.abortController.signal,
      undefined,
      liveProgress,
      { turnKind: preparedTurn.kind || "user" }
    );
    await codex.rememberThread(chatKey, thread);
    return {
      turn,
      threadId: thread.id || codex.getChatThreadId(chatKey) || "",
      executionMode: "inline",
      workerJobId: ""
    };
  }

  return {
    applySideThreadPrompt,
    handleCodexMessage,
    prepareCodexTurn,
    processPreparedTurn,
    runPreparedTurnQueue,
    startPreparedTurnQueue
  };
}
