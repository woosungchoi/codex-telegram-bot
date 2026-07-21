export function createRuntimePanelResolver({
  queue,
  status,
  models,
  keyboards,
  chats,
  localization,
  formatting,
  help,
  presenter
}) {
  const exactResolvers = new Map([
    ["main", async ({ chatKey }) => ({
      html: await presenter.formatMainPanelHtml(chatKey),
      keyboard: keyboards.mainPanel(chatKey)
    })],
    ["status", async ({ chatKey, ctx }) => {
      await queue.pruneExpired(chatKey, ctx);
      return {
        html: status.formatStatus(chatKey, await status.buildDetails(chatKey)),
        keyboard: keyboards.status(chatKey)
      };
    }],
    ["queue", async ({ chatKey, ctx }) => {
      await queue.pruneExpired(chatKey, ctx);
      return {
        html: status.formatQueue(chatKey),
        keyboard: keyboards.queue(chatKey)
      };
    }],
    ["settings", async ({ chatKey }) => ({
      html: presenter.settingsPanelHtml(chatKey),
      keyboard: keyboards.settings()
    })],
    ["settings_model", async ({ chatKey }) => {
      const catalog = await models.list();
      return {
        html: models.formatSelection(chatKey, catalog),
        keyboard: keyboards.settingsSelection(keyboards.modelSelection(catalog), "settings")
      };
    }],
    ["settings_reasoning", async ({ chatKey }) => {
      const catalog = await models.list();
      return {
        html: models.formatReasoningPrompt(chatKey, catalog),
        keyboard: keyboards.settingsSelection(
          keyboards.reasoningSelection(
            models.reasoningOptions(catalog, chats.effectiveModelSlug(chatKey))
          ),
          "settings"
        )
      };
    }],
    ["settings_fast", async ({ chatKey }) => ({
      html: await presenter.fastPanelHtml(chatKey),
      keyboard: keyboards.fast()
    })],
    ["settings_sandbox", async ({ chatKey }) => ({
      html: presenter.settingPanelHtml(
        "Sandbox",
        chats.getEffectiveOptions(chatKey).sandboxMode,
        localization.text("sandboxDescription")
      ),
      keyboard: keyboards.sandbox()
    })],
    ["settings_approval", async ({ chatKey }) => ({
      html: presenter.settingPanelHtml(
        "Approval",
        chats.getEffectiveOptions(chatKey).approvalPolicy,
        localization.text("approvalDescription")
      ),
      keyboard: keyboards.approval()
    })],
    ["settings_web", async ({ chatKey }) => ({
      html: presenter.settingPanelHtml(
        "Web Search",
        chats.getEffectiveOptions(chatKey).webSearchMode,
        localization.text("webDescription")
      ),
      keyboard: keyboards.webSearch()
    })],
    ["settings_network", async ({ chatKey }) => ({
      html: presenter.settingPanelHtml(
        "Network",
        formatting.optional(chats.getEffectiveOptions(chatKey).networkAccessEnabled),
        localization.text("networkDescription")
      ),
      keyboard: keyboards.booleanOption("network")
    })],
    ["settings_stream", async ({ chatKey }) => ({
      html: presenter.settingPanelHtml(
        "Stream",
        String(chats.getEffectiveOptions(chatKey).streamEvents),
        localization.text("streamDescription")
      ),
      keyboard: keyboards.booleanOption("stream")
    })],
    ["settings_live_progress", async ({ chatKey }) => ({
      html: presenter.liveProgressPanelHtml(chatKey),
      keyboard: keyboards.liveProgress(chatKey)
    })],
    ["settings_runtime", async () => ({
      html: presenter.runtimePanelHtml(),
      keyboard: keyboards.runtime()
    })],
    ["settings_runtime_output", async () => ({
      html: presenter.runtimeOutputPanelHtml(),
      keyboard: keyboards.runtimeOutput()
    })],
    ["settings_runtime_queue", async () => ({
      html: presenter.runtimeQueuePanelHtml(),
      keyboard: keyboards.runtimeQueue()
    })],
    ["settings_runtime_codex", async () => ({
      html: presenter.runtimeCodexPanelHtml(),
      keyboard: keyboards.runtimeCodex()
    })],
    ["settings_runtime_cleanup", async () => ({
      html: presenter.runtimeCleanupPanelHtml(),
      keyboard: keyboards.runtimeCleanup()
    })],
    ["settings_runtime_snapshot", async () => ({
      html: presenter.runtimeSnapshotPanelHtml(),
      keyboard: keyboards.runtimeSnapshot()
    })],
    ["settings_git", async ({ chatKey }) => ({
      html: presenter.settingPanelHtml(
        "Git Check",
        String(chats.getEffectiveOptions(chatKey).skipGitRepoCheck),
        localization.text("gitDescription")
      ),
      keyboard: keyboards.booleanOption("skipgit")
    })],
    ["settings_paths", async ({ chatKey }) => ({
      html: presenter.pathsPanelHtml(chatKey),
      keyboard: keyboards.paths()
    })],
    ["settings_schema", async ({ chatKey }) => ({
      html: presenter.schemaPanelHtml(chatKey),
      keyboard: keyboards.schema()
    })],
    ["settings_language", async () => ({
      html: presenter.settingPanelHtml(
        localization.text("languageTitle"),
        localization.language(),
        localization.text("languageDescription")
      ),
      keyboard: keyboards.language()
    })],
    ["settings_timezone", async () => ({
      html: presenter.settingPanelHtml(
        localization.text("timeZoneTitle"),
        localization.timeZone(),
        localization.text("timeZoneDescription")
      ),
      keyboard: keyboards.timeZone()
    })],
    ["settings_locale", async () => ({
      html: presenter.settingPanelHtml(
        localization.text("localeTitle"),
        localization.locale(),
        localization.text("localeDescription")
      ),
      keyboard: keyboards.locale()
    })],
    ["tools", async ({ chatKey }) => ({
      html: presenter.toolsPanelHtml(chatKey),
      keyboard: keyboards.tools()
    })],
    ["help", async () => ({
      html: help.html(),
      keyboard: keyboards.backToMain()
    })]
  ]);

  async function resolvePanel(ctx, panel, chatKey) {
    const exactResolver = exactResolvers.get(panel);
    if (exactResolver) return exactResolver({ ctx, chatKey });
    if (panel.startsWith("settings_timezone_")) {
      const groupId = panel.slice("settings_timezone_".length);
      return {
        html: presenter.timeZoneGroupPanelHtml(groupId),
        keyboard: keyboards.timeZoneGroup(groupId)
      };
    }
    return exactResolvers.get("main")({ ctx, chatKey });
  }

  return { resolvePanel };
}
