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
  function formatStatusHtml(chatKey, details) {
    const lines = [
      b("Codex Telegram Bot"),
      `Checked: ${code(formatting.dateTime(new Date(now())))}`,
      `Thread: ${code(details.threadId || "not started")}`,
      `Active turn: ${code(details.active ? "yes" : "no")}`,
      `Side turns: ${code(details.sideTurns ?? queue.sideTurnCount(chatKey))}`,
      `Queue mode: ${code(details.queueMode ?? queue.mode(chatKey))}`,
      `Queue paused: ${code(details.queuePaused ? "yes" : "no")}`,
      `Queued turns: ${code(details.queued ?? queue.pending(chatKey).length)}`
    ];
    lines.push(...formatPendingDeliveryLines(details.deliverySummary));
    if (details.activeInfo?.currentTurnStartedAt) {
      const elapsed = Math.max(
        0,
        (now() - Date.parse(details.activeInfo.currentTurnStartedAt)) / 1000
      );
      lines.push(
        `Current turn: ${code(formatting.truncate(details.activeInfo.currentText?.replace(/\s+/g, " ") || "unknown", 100))}`,
        `Elapsed: ${code(formatting.duration(elapsed))}`
      );
      if (details.activeInfo.lastProgress) {
        lines.push(
          `Last progress: ${code(formatting.truncate(details.activeInfo.lastProgress, 100))}`,
          `Last progress at: ${code(formatting.dateTime(details.activeInfo.lastProgressAt))}`
        );
      }
    }
    if (details.fallbackSession) {
      lines.push(`Usage source: latest session ${code(details.fallbackSession.id)}`);
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
        b("Codex queue"),
        `Active turn: ${code(activeTurns.has(chatKey) ? "yes" : "no")}`,
        `Side turns: ${code(queue.sideTurnCount(chatKey))}`,
        `Mode: ${code(queue.mode(chatKey))}`,
        `Paused: ${code(queue.isPaused(chatKey) ? "yes" : "no")}`,
        ...deliveryLines,
        localization.text("queueNoTurns")
      ].join("\n");
    }

    const maxAgeSeconds = settings.runtimeValue("telegramPendingTurnMaxAgeSeconds");
    const lines = [
      b("Codex queue"),
      `Active turn: ${code(activeTurns.has(chatKey) ? "yes" : "no")}`,
      `Side turns: ${code(queue.sideTurnCount(chatKey))}`,
      `Mode: ${code(queue.mode(chatKey))}`,
      `Paused: ${code(queue.isPaused(chatKey) ? "yes" : "no")}`,
      `Queued turns: ${code(pending.length)} / ${code(settings.runtimeValue("telegramPendingTurnsMax"))}`,
      ...deliveryLines,
      `Auto expiry: ${code(maxAgeSeconds <= 0 ? "off" : formatting.duration(maxAgeSeconds))}`,
      ""
    ];
    for (const [index, turn] of pending.entries()) {
      const imageSuffix = turn.imagePaths.length > 0 ? `, images:${turn.imagePaths.length}` : "";
      const expires = maxAgeSeconds <= 0
        ? "no expiry"
        : `expires ${formatting.dateTime(turn.expiresAt)}`;
      const kindPrefix = turn.kind === "recovery" ? "[recovery] " : "";
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
      b("Codex queue mode"),
      `Current: ${code(queue.mode(chatKey))}`,
      "",
      `${code("safe")}: ${localization.text("queueModeSafeDescription")}`,
      `${code("interrupt")}: ${localization.text("queueModeInterruptDescription")}`,
      `${code("side")}: ${localization.text("queueModeSideDescription")}`,
      "",
      `Change with ${code("/queue_mode_safe")}, ${code("/queue_mode_interrupt")}, or ${code("/queue_mode_side")}.`
    ].join("\n");
  }

  function formatRestartScheduledHtml(marker) {
    const config = settings.config;
    return formatting.keyValue(localization.text("restartScheduledTitle"), [
      ["restart id", marker.restartId],
      ["active recoveries", marker.recoveries.length],
      ["delay", `${config.botRestartDelaySeconds}s`],
      ["drain timeout", `${config.botRestartDrainTimeoutSeconds}s`],
      ["exit code", marker.exitCode]
    ]);
  }

  function formatRestartRecoveredHtml(marker) {
    return formatting.keyValue(localization.text("recoveryStartupNoticeTitle"), [
      ["restart id", marker.restartId],
      ["recoveries", marker.recoveries?.length ?? 0],
      ["mode", marker.mode || "unknown"]
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
