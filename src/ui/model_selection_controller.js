import {
  findCodexModel,
  isReasoningEffortSupported,
  reasoningOptionsForModel
} from "../codex/models.js";
import { b, code } from "../telegram/html.js";
import {
  applyModelSelectionDraft,
  applyReasoningSelection
} from "./model_selection_flow.js";
import {
  modelSelectionKeyboard,
  reasoningSelectionKeyboard
} from "./keyboards.js";

export function createAtomicChatOptionsReplacer({
  getChat,
  save,
  invalidate,
  now = () => new Date().toISOString()
}) {
  return async function replaceChatOptions(chatKey, nextOptions) {
    const chat = getChat(chatKey);
    const previousOptions = chat.options;
    const previousUpdatedAt = chat.updatedAt;
    chat.options = nextOptions;
    chat.updatedAt = now();
    try {
      await save();
    } catch (error) {
      chat.options = previousOptions;
      chat.updatedAt = previousUpdatedAt;
      throw error;
    }
    invalidate(chatKey);
  };
}

export function createModelSelectionController({
  flowStore,
  models,
  chat,
  telegram,
  views,
  text
}) {
  const t = text;

  async function sendStandaloneModelSelection(ctx, chatKey) {
    const catalog = await models.list();
    const session = flowStore.begin(chatKey, "model");
    try {
      await telegram.replyHtml(
        ctx,
        views.formatModelSelectionHtml(chatKey, catalog),
        views.standaloneModelSelectionKeyboard(catalog, session)
      );
    } catch (error) {
      flowStore.finish(chatKey, session.token);
      throw error;
    }
  }

  async function sendStandaloneReasoningSelection(ctx, chatKey) {
    const catalog = await models.list();
    const session = flowStore.begin(chatKey, "reasoning", {
      modelSlug: chat.effectiveModelSlug(chatKey)
    });
    try {
      await telegram.replyHtml(
        ctx,
        views.formatStandaloneReasoningPromptHtml(session, catalog),
        views.standaloneReasoningSelectionKeyboard(
          reasoningOptionsForModel(catalog, session.modelSlug),
          session
        )
      );
    } catch (error) {
      flowStore.finish(chatKey, session.token);
      throw error;
    }
  }

  async function handleStandaloneModelSelection(ctx, token, model) {
    const chatKey = chat.keyFromContext(ctx);
    const session = await standaloneSelectionSession(ctx, chatKey, token, "model", "model");
    if (!session || await rejectStandaloneSelectionIfActive(ctx, chatKey)) return;
    const processing = flowStore.update(chatKey, token, "model", { phase: "model_processing" });
    if (!processing) {
      await answerSelectionExpiredCallback(ctx);
      return;
    }

    const catalog = await models.list();
    if (model !== "default" && !catalog.some((candidate) => candidate.slug === model)) {
      const edited = await telegram.editStrict(
        ctx,
        `${b(t("modelUnavailable"))}\n\n${views.formatModelSelectionHtml(chatKey, catalog)}`,
        views.standaloneModelSelectionKeyboard(catalog, processing)
      );
      const restored = flowStore.update(chatKey, token, "model_processing", { phase: "model" });
      if (restored) await telegram.answerUiCallback(ctx, edited);
      else await answerSelectionExpiredCallback(ctx);
      return;
    }

    const modelSlug = model === "default" ? models.defaultSlug() : model;
    const next = {
      ...processing,
      phase: "reasoning",
      modelChoice: model,
      modelSlug,
      fastSupported: Boolean(findCodexModel(catalog, modelSlug)?.fastSupported)
    };
    const edited = await telegram.editStrict(
      ctx,
      views.formatStandaloneReasoningPromptHtml(next, catalog),
      views.standaloneReasoningSelectionKeyboard(reasoningOptionsForModel(catalog, modelSlug), next)
    );
    if (edited) {
      const advanced = flowStore.update(chatKey, token, "model_processing", {
        phase: next.phase,
        modelChoice: next.modelChoice,
        modelSlug: next.modelSlug,
        fastSupported: next.fastSupported
      });
      if (!advanced) {
        await answerSelectionExpiredCallback(ctx);
        return;
      }
    } else {
      flowStore.update(chatKey, token, "model_processing", { phase: "model" });
    }
    await telegram.answerUiCallback(ctx, edited);
  }

  async function handleStandaloneReasoningSelection(ctx, token, reasoning) {
    const chatKey = chat.keyFromContext(ctx);
    const session = await standaloneSelectionSession(ctx, chatKey, token, null, "reasoning");
    if (!session || await rejectStandaloneSelectionIfActive(ctx, chatKey)) return;
    const processing = flowStore.update(chatKey, token, "reasoning", {
      phase: "reasoning_processing"
    });
    if (!processing) {
      await answerSelectionExpiredCallback(ctx);
      return;
    }

    const catalog = await models.list();
    const reasoningOptions = reasoningOptionsForModel(catalog, processing.modelSlug);
    if (!standaloneReasoningChoiceSupported(catalog, processing.modelSlug, reasoning)) {
      const edited = await telegram.editStrict(
        ctx,
        `${b(t("thinkingUnavailable"))}\n\n${views.formatStandaloneReasoningPromptHtml(processing, catalog)}`,
        views.standaloneReasoningSelectionKeyboard(reasoningOptions, processing)
      );
      const restored = flowStore.update(chatKey, token, "reasoning_processing", {
        phase: "reasoning"
      });
      if (restored) await telegram.answerUiCallback(ctx, edited);
      else await answerSelectionExpiredCallback(ctx);
      return;
    }

    const fastSupported = processing.kind === "model"
      && processing.fastSupported
      && Boolean(findCodexModel(catalog, processing.modelSlug)?.fastSupported);
    const completed = { ...processing, reasoningChoice: reasoning, fastSupported };
    if (processing.kind === "model" && fastSupported) {
      const fastSession = { ...completed, phase: "fast" };
      const edited = await telegram.editStrict(
        ctx,
        views.formatStandaloneFastPromptHtml(chatKey, fastSession),
        views.standaloneFastSelectionKeyboard(fastSession)
      );
      if (edited) {
        const advanced = flowStore.update(chatKey, token, "reasoning_processing", {
          phase: "fast",
          reasoningChoice: reasoning,
          fastSupported: true
        });
        if (!advanced) {
          await answerSelectionExpiredCallback(ctx);
          return;
        }
      } else {
        flowStore.update(chatKey, token, "reasoning_processing", { phase: "reasoning" });
      }
      await telegram.answerUiCallback(ctx, edited);
      return;
    }

    const committing = flowStore.update(chatKey, token, "reasoning_processing", {
      phase: "committing",
      reasoningChoice: reasoning,
      fastSupported
    });
    if (!committing) {
      await answerSelectionExpiredCallback(ctx);
      return;
    }
    try {
      if (processing.kind === "model") await commitStandaloneModelSelection(chatKey, committing);
      else await commitStandaloneReasoningSelection(chatKey, reasoning);
    } catch (error) {
      const restored = flowStore.update(chatKey, token, "committing", {
        phase: "reasoning"
      });
      if (!restored) {
        await answerSelectionExpiredCallback(ctx);
        return;
      }
      const edited = await telegram.editStrict(
        ctx,
        `${b(t("settingFailure"))}\n${code(error instanceof Error ? error.message : String(error))}\n\n${views.formatStandaloneReasoningPromptHtml(restored, catalog)}`,
        views.standaloneReasoningSelectionKeyboard(reasoningOptions, restored)
      );
      await telegram.answerUiCallback(ctx, edited);
      return;
    }

    flowStore.finish(chatKey, token, "committing");
    const html = processing.kind === "model"
      ? `${b(t("modelSelectionCompleted"))}\n\n${views.formatStandaloneSelectionResultHtml(chatKey, true)}`
      : `${b(t("reasoningSelectionCompleted"))}\n\n${views.formatStandaloneSelectionResultHtml(chatKey)}`;
    const edited = await telegram.editStrict(ctx, html, views.emptyInlineKeyboard());
    await telegram.answerUiCallback(ctx, edited);
  }

  async function handleStandaloneFastSelection(ctx, token, fast) {
    const chatKey = chat.keyFromContext(ctx);
    const session = await standaloneSelectionSession(ctx, chatKey, token, "model", "fast");
    if (!session || await rejectStandaloneSelectionIfActive(ctx, chatKey)) return;
    const committing = flowStore.update(chatKey, token, "fast", {
      phase: "committing",
      fastChoice: fast
    });
    if (!committing) {
      await answerSelectionExpiredCallback(ctx);
      return;
    }

    try {
      await commitStandaloneModelSelection(chatKey, committing);
    } catch (error) {
      const restored = flowStore.update(chatKey, token, "committing", { phase: "fast" });
      if (!restored) {
        await answerSelectionExpiredCallback(ctx);
        return;
      }
      const edited = await telegram.editStrict(
        ctx,
        `${b(t("settingFailure"))}\n${code(error instanceof Error ? error.message : String(error))}\n\n${views.formatStandaloneFastPromptHtml(chatKey, restored)}`,
        views.standaloneFastSelectionKeyboard(restored)
      );
      await telegram.answerUiCallback(ctx, edited);
      return;
    }

    flowStore.finish(chatKey, token, "committing");
    const edited = await telegram.editStrict(
      ctx,
      `${b(t("modelSelectionCompleted"))}\n\n${views.formatStandaloneSelectionResultHtml(chatKey, true)}`,
      views.emptyInlineKeyboard()
    );
    await telegram.answerUiCallback(ctx, edited);
  }

  async function handleStandaloneSelectionCancel(ctx, token) {
    const chatKey = chat.keyFromContext(ctx);
    const current = flowStore.read(chatKey, token);
    if (current?.phase === "committing") {
      await ctx.answerCbQuery(t("selectionFinalizing"), { show_alert: true }).catch(() => {});
      return;
    }
    const session = flowStore.finish(chatKey, token);
    const message = !session
      ? t("selectionExpired")
      : session.kind === "model"
        ? t("modelSelectionCancelled")
        : t("reasoningSelectionCancelled");
    const edited = await telegram.editStrict(ctx, message, views.emptyInlineKeyboard());
    await telegram.answerUiCallback(ctx, edited);
  }

  async function handleMenuClose(ctx) {
    const edited = await telegram.editStrict(ctx, t("menuClosed"), views.emptyInlineKeyboard());
    await telegram.answerUiCallback(ctx, edited);
  }

  async function standaloneSelectionSession(ctx, chatKey, token, kind, phase) {
    const session = flowStore.read(chatKey, token);
    if (session && (!kind || session.kind === kind) && session.phase === phase) return session;
    if (session) {
      await answerSelectionExpiredCallback(ctx);
      return null;
    }
    const edited = await telegram.editStrict(ctx, t("selectionExpired"), views.emptyInlineKeyboard());
    await telegram.answerUiCallback(ctx, edited);
    return null;
  }

  async function answerSelectionExpiredCallback(ctx) {
    await ctx.answerCbQuery(t("selectionExpired"), { show_alert: true }).catch(() => {});
  }

  async function rejectStandaloneSelectionIfActive(ctx, chatKey) {
    if (!chat.isActive(chatKey)) return false;
    await ctx.answerCbQuery(t("selectionBlockedByActiveTurn"), { show_alert: true }).catch(() => {});
    return true;
  }

  function standaloneReasoningChoiceSupported(catalog, modelSlug, reasoning) {
    if (reasoning !== "default") {
      return isReasoningEffortSupported(catalog, modelSlug, reasoning);
    }
    return models.planTransition(catalog, modelSlug, undefined).action !== "reject";
  }

  async function commitStandaloneModelSelection(chatKey, session) {
    await chat.replaceOptions(
      chatKey,
      applyModelSelectionDraft(chat.getOptions(chatKey), session)
    );
  }

  async function commitStandaloneReasoningSelection(chatKey, reasoning) {
    await chat.replaceOptions(
      chatKey,
      applyReasoningSelection(chat.getOptions(chatKey), reasoning)
    );
  }

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
    handleMenuClose,
    handleSettingsModelSelection,
    handleSettingsReasoningSelection,
    handleStandaloneFastSelection,
    handleStandaloneModelSelection,
    handleStandaloneReasoningSelection,
    handleStandaloneSelectionCancel,
    sendStandaloneModelSelection,
    sendStandaloneReasoningSelection
  };
}
