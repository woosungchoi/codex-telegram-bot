import { buildInput, mergeReplyContext } from "./input.js";
import { isStreamIdleTimeout, STREAM_IDLE_TIMEOUT_MESSAGE } from "./watchdog.js";
import { runTelegramFinalDelivery, summarizeTelegramError } from "../telegram/api.js";
import { b, code } from "../telegram/html.js";
import { planIncomingTurn } from "../queue.js";

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
        `<b>Failed to prepare Codex input</b>\n${code(error instanceof Error ? error.message : String(error))}`
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
        `<b>Failed to prepare Codex input</b>\n${code(error instanceof Error ? error.message : String(error))}`
      );
      return;
    }
    const queued = await queue.enqueue(chatKey, preparedTurn);
    if (!queued.ok) {
      await telegram.replyHtml(
        ctx,
        `${b("Codex queue is full.")}\nMax queued turns: ${code(settings.maxPendingTurns())}\nUse ${code("/queue")} or ${code("/cancelqueue")}.`
      );
      return;
    }
    const paused = queue.isPaused(chatKey)
      ? "\nQueue is paused. Use /queue_resume to continue."
      : "";
    await telegram.replyHtml(
      ctx,
      `Queued Codex turn: ${code(`#${queued.position}`)}${paused}\nUse ${code("/queue")} to inspect or ${code("/cancelqueue")} to clear.`
    );
  }

  async function handleInterruptMessage(ctx, chatKey, text, loadImages) {
    let preparedTurn;
    try {
      preparedTurn = await prepareCodexTurn(ctx, text, loadImages);
    } catch (error) {
      await telegram.replyHtml(
        ctx,
        `<b>Failed to prepare Codex input</b>\n${code(error instanceof Error ? error.message : String(error))}`
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
        `${b("Codex queue is full.")}\nMax queued turns: ${code(settings.maxPendingTurns())}\nUse ${code("/queue")} or ${code("/cancelqueue")}.`
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
        `<b>Failed to prepare side input</b>\n${code(error instanceof Error ? error.message : String(error))}`
      );
      return;
    }

    processSideTurn(chatKey, preparedTurn).catch(async (error) => {
      await telegram.replyHtml(
        ctx,
        `<b>Side turn failed</b>\n${code(error instanceof Error ? error.message : String(error))}`
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
        `<b>Queued Codex turn failed</b>\n${code(error instanceof Error ? error.message : String(error))}`
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
      await telegram.replyHtml(ctx, b("Side reply"));
      await telegram.replyCodexAnswer(
        ctx,
        response || "Side Codex turn completed without a final message."
      );
      finalReaction = settings.completeReaction;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      finalReaction = abortController.signal.aborted
        ? settings.stoppedReaction
        : settings.errorReaction;
      await telegram.replyHtml(ctx, `<b>Side Codex failed</b>\n${code(message)}`);
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
    const liveProgress = progress.createState(active);
    liveProgress.chatKey = chatKey;
    let deliveryCompleted = false;
    await recovery.restoreThreadForTurn(chatKey, preparedTurn);
    await recovery.recordActiveTurnStarted(chatKey, preparedTurn);
    await telegram.reactQuietly(ctx, settings.thinkingReaction);
    const typingInterval = timers.setInterval(() => {
      ctx.sendChatAction("typing").catch(() => {});
    }, 4500);

    try {
      let execution;
      try {
        execution = worker.enabled()
          ? await worker.processPreparedTurn(ctx, chatKey, preparedTurn, active, liveProgress)
          : await processPreparedTurnInline(ctx, chatKey, preparedTurn, active, liveProgress);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        finalReaction = active.abortController?.signal?.aborted
          ? settings.stoppedReaction
          : settings.errorReaction;
        if (active.interruptRequested && active.abortController?.signal?.aborted) {
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
          await telegram.replyHtml(ctx, `<b>Codex failed</b>\n${code(message)}`);
        }
        return;
      }

      const response = codex.formatTurn(execution.turn);
      const replyText = response || "Codex completed without a final message.";
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

      await recovery.recordActiveTurnCompleted(
        chatKey,
        execution.threadId || codex.getChatThreadId(chatKey) || ""
      );
      deliveryCompleted = true;
      finalReaction = settings.completeReaction;
    } finally {
      if (progress.shouldDelete(liveProgress, deliveryCompleted)) {
        await progress.deleteMessages(ctx, liveProgress);
      }
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
    const thread = codex.getOrCreateThread(chatKey);
    await codex.maybeNotifyContextPressure(ctx, chatKey, thread);
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
