export function createRuntimePanelController({
  settings,
  state,
  threadCache,
  chats,
  queue,
  status,
  models,
  keyboards,
  views,
  telegram,
  localization,
  formatting,
  help
}) {
  async function sendPanel(ctx, panel, options = {}) {
    const chatKey = telegram.getChatKey(ctx);
    const edit = options.edit === true;
    let html = "";
    let keyboard = {};

    if (panel === "main") {
      html = await formatMainPanelHtml(chatKey);
      keyboard = keyboards.mainPanel(chatKey);
    } else if (panel === "status") {
      await queue.pruneExpired(chatKey, ctx);
      html = status.formatStatus(chatKey, await status.buildDetails(chatKey));
      keyboard = keyboards.status(chatKey);
    } else if (panel === "queue") {
      await queue.pruneExpired(chatKey, ctx);
      html = status.formatQueue(chatKey);
      keyboard = keyboards.queue(chatKey);
    } else if (panel === "settings") {
      html = settingsPanelHtml(chatKey);
      keyboard = keyboards.settings();
    } else if (panel === "settings_model") {
      const catalog = await models.list();
      html = models.formatSelection(chatKey, catalog);
      keyboard = keyboards.settingsSelection(keyboards.modelSelection(catalog), "settings");
    } else if (panel === "settings_reasoning") {
      const catalog = await models.list();
      html = models.formatReasoningPrompt(chatKey, catalog);
      keyboard = keyboards.settingsSelection(
        keyboards.reasoningSelection(
          models.reasoningOptions(catalog, chats.effectiveModelSlug(chatKey))
        ),
        "settings"
      );
    } else if (panel === "settings_fast") {
      html = await fastPanelHtml(chatKey);
      keyboard = keyboards.fast();
    } else if (panel === "settings_sandbox") {
      html = settingPanelHtml(
        "Sandbox",
        chats.getEffectiveOptions(chatKey).sandboxMode,
        localization.text("sandboxDescription")
      );
      keyboard = keyboards.sandbox();
    } else if (panel === "settings_approval") {
      html = settingPanelHtml(
        "Approval",
        chats.getEffectiveOptions(chatKey).approvalPolicy,
        localization.text("approvalDescription")
      );
      keyboard = keyboards.approval();
    } else if (panel === "settings_web") {
      html = settingPanelHtml(
        "Web Search",
        chats.getEffectiveOptions(chatKey).webSearchMode,
        localization.text("webDescription")
      );
      keyboard = keyboards.webSearch();
    } else if (panel === "settings_network") {
      html = settingPanelHtml(
        "Network",
        formatting.optional(chats.getEffectiveOptions(chatKey).networkAccessEnabled),
        localization.text("networkDescription")
      );
      keyboard = keyboards.booleanOption("network");
    } else if (panel === "settings_stream") {
      html = settingPanelHtml(
        "Stream",
        String(chats.getEffectiveOptions(chatKey).streamEvents),
        localization.text("streamDescription")
      );
      keyboard = keyboards.booleanOption("stream");
    } else if (panel === "settings_live_progress") {
      html = liveProgressPanelHtml(chatKey);
      keyboard = keyboards.liveProgress(chatKey);
    } else if (panel === "settings_runtime") {
      html = runtimePanelHtml();
      keyboard = keyboards.runtime();
    } else if (panel === "settings_runtime_output") {
      html = runtimeOutputPanelHtml();
      keyboard = keyboards.runtimeOutput();
    } else if (panel === "settings_runtime_queue") {
      html = runtimeQueuePanelHtml();
      keyboard = keyboards.runtimeQueue();
    } else if (panel === "settings_runtime_codex") {
      html = runtimeCodexPanelHtml();
      keyboard = keyboards.runtimeCodex();
    } else if (panel === "settings_runtime_cleanup") {
      html = runtimeCleanupPanelHtml();
      keyboard = keyboards.runtimeCleanup();
    } else if (panel === "settings_runtime_snapshot") {
      html = runtimeSnapshotPanelHtml();
      keyboard = keyboards.runtimeSnapshot();
    } else if (panel === "settings_git") {
      html = settingPanelHtml(
        "Git Check",
        String(chats.getEffectiveOptions(chatKey).skipGitRepoCheck),
        localization.text("gitDescription")
      );
      keyboard = keyboards.booleanOption("skipgit");
    } else if (panel === "settings_paths") {
      html = pathsPanelHtml(chatKey);
      keyboard = keyboards.paths();
    } else if (panel === "settings_schema") {
      html = schemaPanelHtml(chatKey);
      keyboard = keyboards.schema();
    } else if (panel === "settings_language") {
      html = settingPanelHtml(
        localization.text("languageTitle"),
        localization.language(),
        localization.text("languageDescription")
      );
      keyboard = keyboards.language();
    } else if (panel === "settings_timezone") {
      html = settingPanelHtml(
        localization.text("timeZoneTitle"),
        localization.timeZone(),
        localization.text("timeZoneDescription")
      );
      keyboard = keyboards.timeZone();
    } else if (panel.startsWith("settings_timezone_")) {
      const groupId = panel.slice("settings_timezone_".length);
      html = timeZoneGroupPanelHtml(groupId);
      keyboard = keyboards.timeZoneGroup(groupId);
    } else if (panel === "settings_locale") {
      html = settingPanelHtml(
        localization.text("localeTitle"),
        localization.locale(),
        localization.text("localeDescription")
      );
      keyboard = keyboards.locale();
    } else if (panel === "tools") {
      html = toolsPanelHtml(chatKey);
      keyboard = keyboards.tools();
    } else if (panel === "help") {
      html = help.html();
      keyboard = keyboards.backToMain();
    } else {
      html = await formatMainPanelHtml(chatKey);
      keyboard = keyboards.mainPanel(chatKey);
    }

    keyboard = keyboards.withClose(
      keyboards.withPrevious(keyboard, keyboards.previousPanelFor(panel))
    );
    if (edit) return telegram.editOrReplyHtml(ctx, html, keyboard);
    return telegram.replyHtml(ctx, html, keyboard);
  }

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
    runtimePanelHtml,
    sendPanel,
    settingsPanelHtml
  };
}
