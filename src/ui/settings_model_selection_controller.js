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
  const t = text;

  async function handleSettingsModelSelection(ctx, model) {
    const chatKey = chat.keyFromContext(ctx);
    if (await chat.rejectIfActive(ctx, chatKey)) return;

    const catalog = await models.list();
    const modelKeyboard = views.settingsSelectionKeyboard(modelSelectionKeyboard(catalog), "settings");
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
        `${b(t("thinkingUnavailable"))}\n${code(transition.reasoning || "default")} is not supported by ${code(prospectiveModel || "default")}\n\n${t("modelSelectionDescription")}`,
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
      ? `Reasoning override cleared: ${code(explicitReasoning)}`
      : `Reasoning override cleared: ${code("no")}`;
    await telegram.editOrReplyHtml(
      ctx,
      `${b("Model updated.")}\n${reconciliation}\n\n${views.formatReasoningPromptHtml(chatKey, catalog)}`,
      views.settingsSelectionKeyboard(
        reasoningSelectionKeyboard(reasoningOptions, { callbackPrefix: "rm:" }),
        "settings_model"
      )
    );
  }

  async function handleSettingsReasoningSelection(ctx, reasoning, options) {
    const chatKey = chat.keyFromContext(ctx);
    if (await chat.rejectIfActive(ctx, chatKey)) return;
    const continueToFast = options?.continueToFast === true;

    const catalog = await models.list();
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
          `${b(t("thinkingUnavailable"))}\n${code(transition.reasoning || "default")} is not supported by ${code(effectiveModel || "default")}\n\n${views.formatReasoningPromptHtml(chatKey, catalog)}`,
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
        `${b("Thinking updated.")}\n\n${await views.fastPanelHtml(chatKey)}`,
        views.settingsSelectionKeyboard(views.fastKeyboard(), "settings_reasoning")
      );
      return;
    }

    await telegram.editOrReplyHtml(
      ctx,
      `${b("Thinking updated.")}\n\n${views.formatReasoningPromptHtml(chatKey, catalog)}`,
      reasoningButtons
    );
  }

  return {
    handleSettingsModelSelection,
    handleSettingsReasoningSelection
  };
}
