export function createRuntimePanelPresenter({
  settings,
  state,
  threadCache,
  chats,
  queue,
  status,
  models,
  views,
  localization,
  formatting
}) {
  async function formatMainPanelHtml(chatKey) {
    return views.renderMain({
      details: await status.buildDetails(chatKey),
      options: chats.getEffectiveOptions(chatKey),
      transport: settings.runtimeValue("codexTransport")
    });
  }

  function settingsPanelHtml(chatKey) {
    return views.renderSettings(chats.formatOptions(chatKey));
  }

  async function fastPanelHtml(chatKey) {
    return views.renderFast(await models.formatFastStatus(chatKey, await models.list()));
  }

  function settingPanelHtml(title, current, description) {
    return views.renderSetting(title, current, description);
  }

  function pathsPanelHtml(chatKey) {
    return views.renderPaths(chats.getEffectiveOptions(chatKey));
  }

  function schemaPanelHtml(chatKey) {
    return views.renderSchema(Boolean(chats.get(chatKey).outputSchema));
  }

  function liveProgressPanelHtml(chatKey) {
    return views.renderLiveProgress({
      options: chats.getEffectiveOptions(chatKey),
      mode: settings.runtimeValue("telegramLiveProgressMode"),
      intervalSeconds: settings.runtimeSeconds("telegramLiveProgressIntervalMs")
    });
  }

  function runtimePanelHtml() {
    return views.renderRuntime(runtimeSummaryHtml());
  }

  function runtimeSummaryHtml() {
    return formatting.keyValue("Runtime overrides:", [
      ["worker mode", settings.runtimeValue("codexWorkerMode")],
      ["codex transport", settings.runtimeValue("codexTransport")],
      ["reactions", settings.runtimeValue("telegramReactionsEnabled")],
      ["answer format", settings.runtimeValue("telegramFormatCodexAnswers")],
      ["completion notice", `${settings.runtimeValue("telegramCompletionNoticeSeconds")}s`],
      ["queue max", settings.runtimeValue("telegramPendingTurnsMax")],
      [
        "queue expiry",
        settings.runtimeValue("telegramPendingTurnMaxAgeSeconds") <= 0
          ? "off"
          : formatting.duration(settings.runtimeValue("telegramPendingTurnMaxAgeSeconds"))
      ],
      [
        "cleanup",
        settings.runtimeValue("cleanupEnabled")
          ? `${settings.runtimeValue("cleanupNotifyTime")} ${localization.timeZone()}`
          : "off"
      ],
      [
        "snapshot",
        settings.runtimeValue("snapshotEnabled")
          ? `${settings.runtimeValue("snapshotNotifyTime")} ${localization.timeZone()}`
          : "off"
      ],
      ["logs max lines", settings.runtimeValue("logsMaxLines")],
      ["max message chars", settings.runtimeValue("maxTelegramChars")]
    ]);
  }

  function runtimeOutputPanelHtml() {
    return formatting.keyValue("Output runtime:", [
      ["reactions", settings.runtimeValue("telegramReactionsEnabled")],
      ["answer format", settings.runtimeValue("telegramFormatCodexAnswers")],
      ["completion notice seconds", settings.runtimeValue("telegramCompletionNoticeSeconds")],
      ["max Telegram chars", settings.runtimeValue("maxTelegramChars")],
      ["logs max lines", settings.runtimeValue("logsMaxLines")],
      ["progress edit interval", `${settings.runtimeSeconds("progressEditIntervalMs")}s`]
    ]);
  }

  function runtimeQueuePanelHtml() {
    const maxAge = settings.runtimeValue("telegramPendingTurnMaxAgeSeconds");
    return formatting.keyValue("Queue runtime:", [
      ["pending turns max", settings.runtimeValue("telegramPendingTurnsMax")],
      ["pending max age seconds", maxAge],
      ["pending max age", maxAge <= 0 ? "off" : formatting.duration(maxAge)]
    ]);
  }

  function runtimeCodexPanelHtml() {
    return formatting.keyValue("Codex runtime:", [
      ["worker mode", settings.runtimeValue("codexWorkerMode")],
      ["worker socket", settings.config.codexWorkerSocket],
      ["worker poll", `${settings.runtimeValue("codexWorkerEventPollMs")}ms`],
      ["transport", settings.runtimeValue("codexTransport")],
      ["app-server direct timeout", `${settings.runtimeValue("codexAppServerDirectTimeoutMs")}ms`],
      ["codex path", settings.config.codexPath]
    ]);
  }

  function runtimeCleanupPanelHtml() {
    return formatting.keyValue("Cleanup runtime:", [
      ["enabled", settings.runtimeValue("cleanupEnabled")],
      ["notify time", `${settings.runtimeValue("cleanupNotifyTime")} ${localization.timeZone()}`],
      ["retention days", settings.runtimeValue("cleanupRetentionDays")],
      ["quarantine days", settings.runtimeValue("cleanupQuarantineDays")],
      ["plan ttl hours", settings.runtimeValue("cleanupPlanTtlHours")]
    ]);
  }

  function runtimeSnapshotPanelHtml() {
    return formatting.keyValue("Snapshot runtime:", [
      ["enabled", settings.runtimeValue("snapshotEnabled")],
      ["notify time", `${settings.runtimeValue("snapshotNotifyTime")} ${localization.timeZone()}`],
      ["retention days", settings.runtimeValue("snapshotRetentionDays")]
    ]);
  }

  function toolsPanelHtml(chatKey) {
    const chat = chats.get(chatKey);
    return views.renderTools({
      threadId: chat.threadId || threadCache.get(chatKey)?.id,
      savedChats: Object.keys(state.chats).length,
      pendingTurns: queue.countPending()
    });
  }

  function timeZoneGroupPanelHtml(groupId) {
    return views.renderTimeZoneGroup(groupId, localization.timeZone());
  }

  return {
    fastPanelHtml,
    formatMainPanelHtml,
    liveProgressPanelHtml,
    pathsPanelHtml,
    runtimeCleanupPanelHtml,
    runtimeCodexPanelHtml,
    runtimeOutputPanelHtml,
    runtimePanelHtml,
    runtimeQueuePanelHtml,
    runtimeSnapshotPanelHtml,
    schemaPanelHtml,
    settingPanelHtml,
    settingsPanelHtml,
    timeZoneGroupPanelHtml,
    toolsPanelHtml
  };
}
