import { createMessageFormatter } from "../i18n.js";
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
  const msg = createMessageFormatter(localization.text);
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
    return views.renderFast(await models.formatFastStatus(chatKey, await models.list(chatKey)));
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
    return formatting.keyValue(msg("ui.runtimeOverrides"), [
      [msg("ui.workerMode"), settings.runtimeValue("codexWorkerMode")],
      [msg("ui.codexTransport"), settings.runtimeValue("codexTransport")],
      [msg("ui.reactions"), settings.runtimeValue("telegramReactionsEnabled")],
      [msg("ui.answerFormat"), settings.runtimeValue("telegramFormatCodexAnswers")],
      [msg("ui.completionNotice"), `${settings.runtimeValue("telegramCompletionNoticeSeconds")}s`],
      [msg("ui.queueMax"), settings.runtimeValue("telegramPendingTurnsMax")],
      [
        msg("ui.queueExpiry"),
        settings.runtimeValue("telegramPendingTurnMaxAgeSeconds") <= 0
          ? msg("ui.off")
          : formatting.duration(settings.runtimeValue("telegramPendingTurnMaxAgeSeconds"))
      ],
      [
        msg("ui.cleanup"),
        settings.runtimeValue("cleanupEnabled")
          ? `${settings.runtimeValue("cleanupNotifyTime")} ${localization.timeZone()} · ${settings.runtimeValue("cleanupExecutionMode")}`
          : msg("ui.off")
      ],
      [
        msg("ui.snapshot"),
        settings.runtimeValue("snapshotEnabled")
          ? `${settings.runtimeValue("snapshotNotifyTime")} ${localization.timeZone()}`
          : msg("ui.off")
      ],
      [msg("ui.logsMaxLines"), settings.runtimeValue("logsMaxLines")],
      [msg("ui.maxMessageChars"), settings.runtimeValue("maxTelegramChars")]
    ]);
  }

  function runtimeOutputPanelHtml() {
    return formatting.keyValue(msg("ui.outputRuntime"), [
      [msg("ui.reactions"), settings.runtimeValue("telegramReactionsEnabled")],
      [msg("ui.answerFormat"), settings.runtimeValue("telegramFormatCodexAnswers")],
      [msg("ui.completionNoticeSeconds"), settings.runtimeValue("telegramCompletionNoticeSeconds")],
      [msg("ui.maxTelegramChars"), settings.runtimeValue("maxTelegramChars")],
      [msg("ui.logsMaxLines"), settings.runtimeValue("logsMaxLines")],
      [msg("ui.progressEditInterval"), `${settings.runtimeSeconds("progressEditIntervalMs")}s`]
    ]);
  }

  function runtimeQueuePanelHtml() {
    const maxAge = settings.runtimeValue("telegramPendingTurnMaxAgeSeconds");
    return formatting.keyValue(msg("ui.queueRuntime"), [
      [msg("ui.pendingTurnsMax"), settings.runtimeValue("telegramPendingTurnsMax")],
      [msg("ui.pendingMaxAgeSeconds"), maxAge],
      [msg("ui.pendingMaxAge"), maxAge <= 0 ? msg("ui.off") : formatting.duration(maxAge)]
    ]);
  }

  function runtimeCodexPanelHtml() {
    return formatting.keyValue(msg("ui.codexRuntime"), [
      [msg("ui.workerMode"), settings.runtimeValue("codexWorkerMode")],
      [msg("ui.workerSocket"), settings.config.codexWorkerSocket],
      [msg("ui.workerPoll"), `${settings.runtimeValue("codexWorkerEventPollMs")}ms`],
      [msg("ui.transport"), settings.runtimeValue("codexTransport")],
      [msg("ui.appServerDirectTimeout"), `${settings.runtimeValue("codexAppServerDirectTimeoutMs")}ms`],
      [msg("ui.codexPath"), settings.config.codexPath]
    ]);
  }

  function runtimeCleanupPanelHtml() {
    return formatting.keyValue(msg("ui.cleanupRuntime"), [
      [msg("ui.enabled"), settings.runtimeValue("cleanupEnabled")],
      [msg("ui.executionMode"), settings.runtimeValue("cleanupExecutionMode")],
      [msg("ui.notifyTime"), `${settings.runtimeValue("cleanupNotifyTime")} ${localization.timeZone()}`],
      [msg("ui.retentionDays"), settings.runtimeValue("cleanupRetentionDays")],
      [msg("ui.quarantineDays"), settings.runtimeValue("cleanupQuarantineDays")],
      [msg("ui.planTtlHours"), settings.runtimeValue("cleanupPlanTtlHours")]
    ]);
  }

  function runtimeSnapshotPanelHtml() {
    return formatting.keyValue(msg("ui.snapshotRuntime"), [
      [msg("ui.enabled"), settings.runtimeValue("snapshotEnabled")],
      [msg("ui.notifyTime"), `${settings.runtimeValue("snapshotNotifyTime")} ${localization.timeZone()}`],
      [msg("ui.retentionDays"), settings.runtimeValue("snapshotRetentionDays")]
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
