import { createMessageFormatter } from "../i18n.js";
import {
  findCodexModel,
  readCodexModelCatalog,
  reasoningOptionsForModel
} from "../codex/models.js";
import { b, code } from "../telegram/html.js";
import { accountConfig, selectedAccountId } from "../accounts/context.js";

export function createModelPresenter({ settings, state, chats, localization, formatting }) {
  const msg = createMessageFormatter(localization.text);
  async function listCodexModels(chatKey) {
    const config = chatKey ? accountConfig(settings.config,
      selectedAccountId(state.chats[chatKey] || { accountId: state.accountDefaultId })) : settings.config;
    return readCodexModelCatalog(config.codexModelsCacheFile);
  }

  function formatReasoningPromptHtml(chatKey, models) {
    const chatOptions = state.chats[chatKey]?.options ?? {};
    const model = chats.effectiveModelSlug(chatKey);
    const reasoning = chatOptions.modelReasoningEffort ?? settings.config.codexReasoningEffort;
    const catalogModel = findCodexModel(models, model);
    const supported = reasoningOptionsForModel(models, model).map(({ effort }) => effort);
    const lines = [
      b(localization.text("thinkingSettingsTitle")),
      msg("ui.modelLine", { value1: code(model || msg("ui.default")) }),
      msg("ui.currentThinkingLine", { value1: code(reasoning) })
    ];
    if (catalogModel) {
      lines.push(msg("ui.catalogDefaultLine", { value1: code(catalogModel.defaultReasoning || msg("ui.unknown")) }));
    }
    lines.push(
      msg("ui.supportedThinkingLine", { value1: code(supported.length > 0 ? supported.join(", ") : msg("ui.none")) }),
      "",
      localization.text("thinkingSettingsDescription")
    );
    return lines.join("\n");
  }

  function formatStandaloneReasoningPromptHtml(session, models) {
    const catalogModel = findCodexModel(models, session.modelSlug);
    const supported = reasoningOptionsForModel(models, session.modelSlug).map(({ effort }) => effort);
    const lines = [
      b(localization.text("thinkingSettingsTitle")),
      `${localization.text("selectedModelLabel")}: ${code(session.modelSlug || msg("ui.default"))}`,
      `${localization.text("selectedThinkingLabel")}: ${code(session.reasoningChoice || localization.text("notSelected"))}`
    ];
    if (catalogModel) {
      lines.push(
        `${localization.text("catalogDefaultLabel")}: ${code(catalogModel.defaultReasoning || msg("ui.unknown"))}`
      );
    }
    lines.push(
      `${localization.text("supportedThinkingLabel")}: ${code(supported.length > 0 ? supported.join(", ") : msg("ui.none"))}`,
      "",
      localization.text("thinkingSettingsDescription")
    );
    return lines.join("\n");
  }

  function formatStandaloneFastPromptHtml(chatKey, session) {
    const currentTier = chats.getEffectiveOptions(chatKey).serviceTier ?? msg("ui.default");
    return [
      b(localization.text("fastSelectionTitle")),
      `${localization.text("selectedModelLabel")}: ${code(session.modelSlug || msg("ui.default"))}`,
      `${localization.text("selectedThinkingLabel")}: ${code(session.reasoningChoice || msg("ui.default"))}`,
      `${localization.text("currentFastLabel")}: ${code(currentTier === "fast" ? localization.text("on") : localization.text("off"))}`,
      "",
      localization.text("fastSelectionDescription")
    ].join("\n");
  }

  function formatStandaloneSelectionResultHtml(chatKey, includeFast = false) {
    const options = chats.getEffectiveOptions(chatKey);
    const lines = [
      `${localization.text("selectedModelLabel")}: ${code(options.model || msg("ui.default"))}`,
      `${localization.text("selectedThinkingLabel")}: ${code(options.modelReasoningEffort)}`
    ];
    if (includeFast) {
      const fast = options.serviceTier === "fast"
        ? localization.text("on")
        : options.serviceTier || localization.text("off");
      lines.push(`${localization.text("currentFastLabel")}: ${code(fast)}`);
    }
    return lines.join("\n");
  }

  function formatFastStatusHtml(chatKey, models) {
    const options = chats.getEffectiveOptions(chatKey);
    const fastModels = models
      .filter((model) => model.fastSupported)
      .map((model) => model.slug);
    return formatting.keyValue(msg("ui.fastServiceTier"), [
      [msg("ui.fast"), options.serviceTier === "fast" ? msg("ui.on") : msg("ui.off")],
      [msg("ui.serviceTier"), options.serviceTier || msg("ui.default")],
      [msg("ui.currentModel"), options.model || msg("ui.default")],
      [msg("ui.fastSupportedModels"), fastModels.length > 0 ? fastModels.join(", ") : msg("ui.unknown")]
    ]);
  }

  function formatOptionsHtml(chatKey) {
    const options = chats.getEffectiveOptions(chatKey);
    return formatting.keyValue(msg("ui.options"), [
      [msg("ui.model"), options.model || msg("ui.default")],
      [msg("ui.workingDirectory"), options.workingDirectory],
      [msg("ui.sandboxMode"), options.sandboxMode],
      [msg("ui.approvalPolicy"), options.approvalPolicy],
      [msg("ui.skipGitRepoCheck"), options.skipGitRepoCheck],
      [msg("ui.modelReasoningEffort"), options.modelReasoningEffort],
      [msg("ui.serviceTier2"), options.serviceTier || msg("ui.default")],
      [msg("ui.webSearchMode"), options.webSearchMode],
      [msg("ui.networkAccessEnabled"), formatting.optional(options.networkAccessEnabled)],
      [msg("ui.additionalDirectories"), (options.additionalDirectories ?? []).join(", ") || msg("ui.none")],
      [msg("ui.streamEvents"), options.streamEvents],
      [msg("ui.liveProgressEnabled"), options.liveProgressEnabled],
      [msg("ui.liveProgressSource"), options.liveProgressSource],
      [msg("ui.liveProgressDeletePolicy"), options.liveProgressDeletePolicy],
      [msg("ui.language"), localization.language()],
      [msg("ui.timeZone"), localization.timeZone()],
      [msg("ui.locale"), localization.locale()],
      [msg("ui.outputSchema"), chats.get(chatKey).outputSchema ? msg("ui.enabled") : msg("ui.disabled")]
    ]);
  }

  return {
    formatFastStatusHtml,
    formatOptionsHtml,
    formatReasoningPromptHtml,
    formatStandaloneFastPromptHtml,
    formatStandaloneReasoningPromptHtml,
    formatStandaloneSelectionResultHtml,
    listCodexModels
  };
}
