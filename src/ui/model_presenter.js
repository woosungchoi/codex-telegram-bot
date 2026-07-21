import {
  findCodexModel,
  readCodexModelCatalog,
  reasoningOptionsForModel
} from "../codex/models.js";
import { b, code } from "../telegram/html.js";

export function createModelPresenter({ settings, state, chats, localization, formatting }) {
  async function listCodexModels() {
    return readCodexModelCatalog(settings.config.codexModelsCacheFile);
  }

  function formatReasoningPromptHtml(chatKey, models) {
    const chatOptions = state.chats[chatKey]?.options ?? {};
    const model = chats.effectiveModelSlug(chatKey);
    const reasoning = chatOptions.modelReasoningEffort ?? settings.config.codexReasoningEffort;
    const catalogModel = findCodexModel(models, model);
    const supported = reasoningOptionsForModel(models, model).map(({ effort }) => effort);
    const lines = [
      b(localization.text("thinkingSettingsTitle")),
      `Model: ${code(model || "default")}`,
      `Current thinking: ${code(reasoning)}`
    ];
    if (catalogModel) {
      lines.push(`Catalog default: ${code(catalogModel.defaultReasoning || "unknown")}`);
    }
    lines.push(
      `Supported thinking: ${code(supported.length > 0 ? supported.join(", ") : "none")}`,
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
      `${localization.text("selectedModelLabel")}: ${code(session.modelSlug || "default")}`,
      `${localization.text("selectedThinkingLabel")}: ${code(session.reasoningChoice || localization.text("notSelected"))}`
    ];
    if (catalogModel) {
      lines.push(
        `${localization.text("catalogDefaultLabel")}: ${code(catalogModel.defaultReasoning || "unknown")}`
      );
    }
    lines.push(
      `${localization.text("supportedThinkingLabel")}: ${code(supported.length > 0 ? supported.join(", ") : "none")}`,
      "",
      localization.text("thinkingSettingsDescription")
    );
    return lines.join("\n");
  }

  function formatStandaloneFastPromptHtml(chatKey, session) {
    const currentTier = chats.getEffectiveOptions(chatKey).serviceTier ?? "default";
    return [
      b(localization.text("fastSelectionTitle")),
      `${localization.text("selectedModelLabel")}: ${code(session.modelSlug || "default")}`,
      `${localization.text("selectedThinkingLabel")}: ${code(session.reasoningChoice || "default")}`,
      `${localization.text("currentFastLabel")}: ${code(currentTier === "fast" ? localization.text("on") : localization.text("off"))}`,
      "",
      localization.text("fastSelectionDescription")
    ].join("\n");
  }

  function formatStandaloneSelectionResultHtml(chatKey, includeFast = false) {
    const options = chats.getEffectiveOptions(chatKey);
    const lines = [
      `${localization.text("selectedModelLabel")}: ${code(options.model || "default")}`,
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
    return formatting.keyValue("Fast service tier:", [
      ["fast", options.serviceTier === "fast" ? "on" : "off"],
      ["service_tier", options.serviceTier || "default"],
      ["current model", options.model || "default"],
      ["fast-supported models", fastModels.length > 0 ? fastModels.join(", ") : "unknown"]
    ]);
  }

  function formatOptionsHtml(chatKey) {
    const options = chats.getEffectiveOptions(chatKey);
    return formatting.keyValue("Options:", [
      ["model", options.model || "default"],
      ["workingDirectory", options.workingDirectory],
      ["sandboxMode", options.sandboxMode],
      ["approvalPolicy", options.approvalPolicy],
      ["skipGitRepoCheck", options.skipGitRepoCheck],
      ["modelReasoningEffort", options.modelReasoningEffort],
      ["serviceTier", options.serviceTier || "default"],
      ["webSearchMode", options.webSearchMode],
      ["networkAccessEnabled", formatting.optional(options.networkAccessEnabled)],
      ["additionalDirectories", (options.additionalDirectories ?? []).join(", ") || "none"],
      ["streamEvents", options.streamEvents],
      ["liveProgressEnabled", options.liveProgressEnabled],
      ["liveProgressSource", options.liveProgressSource],
      ["liveProgressDeletePolicy", options.liveProgressDeletePolicy],
      ["language", localization.language()],
      ["timeZone", localization.timeZone()],
      ["locale", localization.locale()],
      ["outputSchema", chats.get(chatKey).outputSchema ? "enabled" : "disabled"]
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
