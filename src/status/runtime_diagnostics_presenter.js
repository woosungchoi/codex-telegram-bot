import { createMessageFormatter } from "../i18n.js";
import { b, code, pre } from "../telegram/html.js";
import { summarizeWorkerDeliveryStatus } from "../worker/delivery.js";

export function createRuntimeDiagnosticsPresenter({
  settings,
  state,
  activeTurns,
  queue,
  options,
  localization,
  formatting,
  now
}) {
  const msg = createMessageFormatter(localization.text);
  function formatStatusHtml(chatKey, details) {
    const lines = [
      b(msg("ui.codexTelegramBot")),
      msg("ui.checkedLine", { value1: code(formatting.dateTime(new Date(now()))) }),
      msg("ui.threadLine", { value1: code(details.threadId || msg("ui.notStarted")) }),
      msg("ui.activeTurnLine", { value1: code(details.active ? msg("ui.yes") : msg("ui.no")) }),
      msg("ui.sideTurnsLine", { value1: code(details.sideTurns ?? queue.sideTurnCount(chatKey)) }),
      msg("ui.queueModeLine", { value1: code(details.queueMode ?? queue.mode(chatKey)) }),
      msg("ui.queuePausedLine", { value1: code(details.queuePaused ? msg("ui.yes") : msg("ui.no")) }),
      msg("ui.queuedTurnsLine", { value1: code(details.queued ?? queue.pending(chatKey).length) })
    ];
    lines.push(...formatPendingDeliveryLines(details.deliverySummary));
    if (details.activeInfo?.currentTurnStartedAt) {
      const elapsed = Math.max(
        0,
        (now() - Date.parse(details.activeInfo.currentTurnStartedAt)) / 1000
      );
      lines.push(
        msg("ui.currentTurnLine", { value1: code(formatting.truncate(details.activeInfo.currentText?.replace(/\s+/g, " ") || msg("ui.unknown"), 100)) }),
        msg("ui.elapsedLine", { value1: code(formatting.duration(elapsed)) })
      );
      if (details.activeInfo.lastProgress) {
        lines.push(
          msg("ui.lastProgressLine", { value1: code(formatting.truncate(details.activeInfo.lastProgress, 100)) }),
          msg("ui.lastProgressAtLine", { value1: code(formatting.dateTime(details.activeInfo.lastProgressAt)) })
        );
      }
    }
    if (details.fallbackSession) {
      lines.push(msg("ui.usageSourceLatestSessionLine", { value1: code(details.fallbackSession.id) }));
    }
    if (details.usageSummary) lines.push("", pre(details.usageSummary));
    lines.push("", options.format(chatKey));
    return lines.join("\n");
  }

  function formatQueueHtml(chatKey) {
    const pending = queue.pending(chatKey);
    const deliveryLines = formatPendingDeliveryLines(
      summarizeWorkerDeliveryStatus(state.worker?.deliveries, chatKey)
    );
    if (pending.length === 0) {
      return [
        b(msg("ui.codexQueue")),
        msg("ui.activeTurnLine", { value1: code(activeTurns.has(chatKey) ? msg("ui.yes") : msg("ui.no")) }),
        msg("ui.sideTurnsLine", { value1: code(queue.sideTurnCount(chatKey)) }),
        msg("ui.modeLine", { value1: code(queue.mode(chatKey)) }),
        msg("ui.pausedLine", { value1: code(queue.isPaused(chatKey) ? msg("ui.yes") : msg("ui.no")) }),
        ...deliveryLines,
        localization.text("queueNoTurns")
      ].join("\n");
    }

    const maxAgeSeconds = settings.runtimeValue("telegramPendingTurnMaxAgeSeconds");
    const lines = [
      b(msg("ui.codexQueue")),
      msg("ui.activeTurnLine", { value1: code(activeTurns.has(chatKey) ? msg("ui.yes") : msg("ui.no")) }),
      msg("ui.sideTurnsLine", { value1: code(queue.sideTurnCount(chatKey)) }),
      msg("ui.modeLine", { value1: code(queue.mode(chatKey)) }),
      msg("ui.pausedLine", { value1: code(queue.isPaused(chatKey) ? msg("ui.yes") : msg("ui.no")) }),
      msg("ui.queuedTurnsLine2", { value1: code(pending.length), value2: code(settings.runtimeValue("telegramPendingTurnsMax")) }),
      ...deliveryLines,
      msg("ui.autoExpiryLine", { value1: code(maxAgeSeconds <= 0 ? msg("ui.off") : formatting.duration(maxAgeSeconds)) }),
      ""
    ];
    for (const [index, turn] of pending.entries()) {
      const imageSuffix = turn.imagePaths.length > 0 ? msg("ui.imagesLine", { value1: turn.imagePaths.length }) : "";
      const expires = maxAgeSeconds <= 0
        ? msg("ui.noExpiry")
        : msg("ui.expiresLine2", { value1: formatting.dateTime(turn.expiresAt) });
      const kindPrefix = turn.kind === "recovery" ? msg("ui.recovery") : "";
      lines.push(
        `${index + 1}. ${code(`${kindPrefix}${formatting.truncate(turn.text.replace(/\s+/g, " "), 120)}`)} (${code(turn.id)}, ${code(formatting.dateTime(turn.enqueuedAt))}, ${code(expires)}${imageSuffix})`
      );
    }
    lines.push("", localization.text("queueButtonsHelp"));
    return lines.join("\n");
  }

  function formatPendingDeliveryLines(summary) {
    if (!summary || summary.count <= 0) return [];
    const deliveryKey = summary.status === "uncertain"
      ? "telegramDeliveryUncertain"
      : "telegramDeliveryPending";
    const recoveryKey = summary.recovery === "automatic_replay_disabled"
      ? "telegramDeliveryReplayDisabled"
      : summary.recovery === "manual_review_required"
        ? "telegramDeliveryManualReview"
        : "telegramDeliverySafeReplay";
    return [
      localization.text("deliveryCodexExecutionCompleted"),
      localization.formatText(deliveryKey, { count: summary.count }),
      localization.text(recoveryKey)
    ];
  }

  function formatQueueModeHtml(chatKey) {
    return [
      b(msg("ui.codexQueueMode")),
      msg("ui.currentLine", { value1: code(queue.mode(chatKey)) }),
      "",
      `${code(msg("ui.safe"))}: ${localization.text("queueModeSafeDescription")}`,
      `${code(msg("ui.interrupt"))}: ${localization.text("queueModeInterruptDescription")}`,
      `${code(msg("ui.side"))}: ${localization.text("queueModeSideDescription")}`,
      "",
      msg("ui.changeWithOrLine", { value1: code("/queue_mode_safe"), value2: code("/queue_mode_interrupt"), value3: code("/queue_mode_side") })
    ].join("\n");
  }

  function formatRestartScheduledHtml(marker) {
    const config = settings.config;
    return formatting.keyValue(localization.text("restartScheduledTitle"), [
      [msg("ui.restartId"), marker.restartId],
      [msg("ui.activeRecoveries"), marker.recoveries.length],
      [msg("ui.delay"), `${config.botRestartDelaySeconds}s`],
      [msg("ui.drainTimeout"), `${config.botRestartDrainTimeoutSeconds}s`],
      [msg("ui.exitCode"), marker.exitCode]
    ]);
  }

  function formatRestartRecoveredHtml(marker) {
    return formatting.keyValue(localization.text("recoveryStartupNoticeTitle"), [
      [msg("ui.restartId"), marker.restartId],
      [msg("ui.recoveries"), marker.recoveries?.length ?? 0],
      [msg("ui.mode"), marker.mode || msg("ui.unknown")]
    ]);
  }

  return {
    formatPendingDeliveryLines,
    formatQueueHtml,
    formatQueueModeHtml,
    formatRestartRecoveredHtml,
    formatRestartScheduledHtml,
    formatStatusHtml
  };
}
