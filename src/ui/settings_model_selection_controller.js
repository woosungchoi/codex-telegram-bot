import { createMessageFormatter } from "../i18n.js";
import {
  findCodexModel,
  isReasoningEffortSupported,
  reasoningOptionsForModel
} from "../codex/models.js";
import { b, code } from "../telegram/html.js";
import { applyReasoningSelection } from "./model_selection_flow.js";
import {
  modelSelectionKeyboard,
  reasoningSelectionKeyboard
} from "./keyboards.js";

export function createSettingsModelSelectionController({
  models,
  chat,
  telegram,
  views,
  text
}) {
  const msg = createMessageFormatter(text);
  const t = text;

  async function handleSettingsModelSelection(ctx, model) {
    const chatKey = chat.keyFromContext(ctx);
    if (await chat.rejectIfActive(ctx, chatKey)) return;

    const catalog = await models.list(chatKey);
    const modelKeyboard = views.settingsSelectionKeyboard(modelSelectionKeyboard(catalog, { text }), "settings");
    if (model !== "default" && !catalog.some((candidate) => candidate.slug === model)) {
      await telegram.editOrReplyHtml(
        ctx,
        `${b(t("modelUnavailable"))}\n\n${views.formatModelSelectionHtml(chatKey, catalog)}`,
        modelKeyboard
      );
      return;
    }

    const prospectiveModel = model === "default" ? models.defaultSlug() : model;
    const explicitReasoning = chat.getOptions(chatKey).modelReasoningEffort;
    const transition = models.planTransition(
      catalog,
      prospectiveModel,
      explicitReasoning,
      true
    );
    if (transition.action === "reject") {
      await telegram.editOrReplyHtml(
        ctx,
        msg("ui.isNotSupportedByLine", { value1: b(t("thinkingUnavailable")), value2: code(transition.reasoning || msg("ui.default")), value3: code(prospectiveModel || msg("ui.default")), value4: t("modelSelectionDescription") }),
        modelKeyboard
      );
      return;
    }

    const nextOptions = { ...chat.getOptions(chatKey) };
    if (model === "default") delete nextOptions.model;
    else nextOptions.model = model;
    if (transition.action === "clear") delete nextOptions.modelReasoningEffort;
    const catalogModel = findCodexModel(catalog, prospectiveModel);
    if (!catalogModel?.fastSupported && nextOptions.serviceTier === "fast") {
      delete nextOptions.serviceTier;
    }
    await chat.replaceOptions(chatKey, nextOptions);

    const reasoningOptions = reasoningOptionsForModel(catalog, prospectiveModel);
    const reconciliation = transition.action === "clear"
      ? msg("ui.reasoningOverrideClearedLine", { value1: code(explicitReasoning) })
      : msg("ui.reasoningOverrideClearedLine", { value1: code(msg("ui.no")) });
    await telegram.editOrReplyHtml(
      ctx,
      `${b(msg("ui.modelUpdated"))}\n${reconciliation}\n\n${views.formatReasoningPromptHtml(chatKey, catalog)}`,
      views.settingsSelectionKeyboard(
        reasoningSelectionKeyboard(reasoningOptions, { callbackPrefix: "rm:", text }),
        "settings_model"
      )
    );
  }

  async function handleSettingsReasoningSelection(ctx, reasoning, options) {
    const chatKey = chat.keyFromContext(ctx);
    if (await chat.rejectIfActive(ctx, chatKey)) return;
    const continueToFast = options?.continueToFast === true;

    const catalog = await models.list(chatKey);
    const effectiveModel = chat.effectiveModelSlug(chatKey);
    const reasoningOptions = reasoningOptionsForModel(catalog, effectiveModel);
    const reasoningButtons = views.settingsSelectionKeyboard(
      reasoningSelectionKeyboard(reasoningOptions),
      continueToFast ? "settings_model" : "settings"
    );
    if (reasoning === "default") {
      const transition = models.planTransition(catalog, effectiveModel, undefined);
      if (transition.action === "reject") {
        await telegram.editOrReplyHtml(
          ctx,
          msg("ui.isNotSupportedByLine", { value1: b(t("thinkingUnavailable")), value2: code(transition.reasoning || msg("ui.default")), value3: code(effectiveModel || msg("ui.default")), value4: views.formatReasoningPromptHtml(chatKey, catalog) }),
          reasoningButtons
        );
        return;
      }
    }
    if (reasoning !== "default" && !isReasoningEffortSupported(catalog, effectiveModel, reasoning)) {
      await telegram.editOrReplyHtml(
        ctx,
        `${b(t("thinkingUnavailable"))}\n\n${views.formatReasoningPromptHtml(chatKey, catalog)}`,
        reasoningButtons
      );
      return;
    }

    await chat.replaceOptions(
      chatKey,
      applyReasoningSelection(chat.getOptions(chatKey), reasoning)
    );
    const fastSupported = Boolean(findCodexModel(catalog, effectiveModel)?.fastSupported);
    if (continueToFast && fastSupported) {
      await telegram.editOrReplyHtml(
        ctx,
        `${b(msg("ui.thinkingUpdated"))}\n\n${await views.fastPanelHtml(chatKey)}`,
        views.settingsSelectionKeyboard(views.fastKeyboard(), "settings_reasoning")
      );
      return;
    }

    await telegram.editOrReplyHtml(
      ctx,
      `${b(msg("ui.thinkingUpdated"))}\n\n${views.formatReasoningPromptHtml(chatKey, catalog)}`,
      reasoningButtons
    );
  }

  return {
    handleSettingsModelSelection,
    handleSettingsReasoningSelection
  };
}
