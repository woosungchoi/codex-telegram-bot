import { errorText, LocalizedError, createMessageFormatter } from "../i18n.js";
import {
  isReasoningEffortSupported,
  reasoningOptionsForModel
} from "./models.js";
import {
  mergeAdditionalDirectories,
  planModelReasoningTransition
} from "./options.js";
import { b, code } from "../telegram/html.js";
import { assertTopicDirectory } from "../forum/store.js";

export function createChatOptionsController({
  settings,
  stateStore,
  threadCache,
  models,
  telegram,
  validation,
  text: t,
  now = () => new Date()
}) {
  const msg = createMessageFormatter(t);
  function defaultChatOptions() {
    const options = {
      workingDirectory: settings.workingDirectory,
      skipGitRepoCheck: settings.skipGitRepoCheck,
      approvalPolicy: settings.approvalPolicy,
      sandboxMode: settings.sandboxMode,
      modelReasoningEffort: settings.reasoningEffort,
      webSearchMode: settings.webSearchMode,
      streamEvents: true,
      liveProgressEnabled: settings.liveProgressEnabled(),
      liveProgressSource: settings.liveProgressSource,
      liveProgressDeletePolicy: settings.liveProgressDeletePolicy
    };
    if (settings.model) options.model = settings.model;
    if (typeof settings.networkAccessEnabled === "boolean") {
      options.networkAccessEnabled = settings.networkAccessEnabled;
    }
    if (typeof settings.webSearchEnabled === "boolean") {
      options.webSearchEnabled = settings.webSearchEnabled;
    }
    const additionalDirectories = mergeAdditionalDirectories(
      settings.additionalDirectories,
      settings.uploadDir
    );
    if (additionalDirectories.length > 0) {
      options.additionalDirectories = additionalDirectories;
    }
    return options;
  }

  function buildTurnOptions(chatKey, signal) {
    const chat = getChatState(chatKey);
    const options = { signal };
    if (chat.outputSchema) options.outputSchema = chat.outputSchema;
    return options;
  }

  function getEffectiveOptions(chatKey) {
    const chat = getChatState(chatKey);
    return { ...defaultChatOptions(), ...chat.options,
      ...(chat.forumBinding?.cwd ? { workingDirectory: chat.forumBinding.cwd } : {}) };
  }

  function effectiveModelSlug(chatKey) {
    return stateStore.chats[chatKey]?.options?.model ?? settings.model ?? "";
  }

  function planRuntimeModelReasoningTransition(
    catalog,
    modelSlug,
    explicitReasoning,
    allowExplicitClear = false
  ) {
    return planModelReasoningTransition({
      models: catalog,
      modelSlug,
      explicitReasoning,
      configuredReasoning: settings.reasoningEffort,
      allowExplicitClear
    });
  }

  function getChatState(chatKey) {
    if (!stateStore.chats[chatKey]) {
      stateStore.chats[chatKey] = { options: {}, updatedAt: now().toISOString() };
    }
    if (!stateStore.chats[chatKey].options) stateStore.chats[chatKey].options = {};
    const accountId = stateStore.defaultAccountId?.();
    if (!stateStore.chats[chatKey].accountId && accountId) stateStore.chats[chatKey].accountId = accountId;
    return stateStore.chats[chatKey];
  }

  async function updateOptionCommand(ctx, key, usage) {
    const chatKey = telegram.getChatKey(ctx);
    if (await telegram.rejectIfActive(ctx, chatKey)) return;
    const value = telegram.getCommandArgs(ctx).trim();
    if (!value) {
      await telegram.replyHtml(
        ctx,
        msg("ui.usageLine", { value1: code(`/${telegram.commandName(ctx)} <${usage}>`) })
      );
      return;
    }
    await updateOptionValue(ctx, key, value);
  }

  async function updateOptionValue(ctx, key, value) {
    const chatKey = telegram.getChatKey(ctx);
    if (await telegram.rejectIfActive(ctx, chatKey)) return;
    try {
      await setOption(chatKey, key, value);
    } catch (error) {
      await telegram.replyHtml(
        ctx,
        code(errorText(error, t))
      );
      return;
    }
    await stateStore.save();
    await telegram.replyHtml(
      ctx,
      `${b(msg("ui.updatedLine", { value1: key }))}\n\n${telegram.formatOptionsHtml(chatKey)}`
    );
  }

  async function setOption(chatKey, key, rawValue) {
    const value = rawValue.trim();
    if (key === "workingDirectory") assertTopicDirectory(getChatState(chatKey), value);
    const lower = value.toLowerCase();
    const clearsOption = lower === "off" || lower === "default" || lower === "clear";
    let transition = { action: "keep" };
    if (key === "model") {
      const catalog = await models.list();
      const prospectiveModel = clearsOption ? settings.model ?? "" : value;
      transition = planRuntimeModelReasoningTransition(
        catalog,
        prospectiveModel,
        stateStore.chats[chatKey]?.options?.modelReasoningEffort,
        true
      );
      if (transition.action === "reject") {
        const supported = reasoningOptionsForModel(catalog, prospectiveModel)
          .map(({ effort }) => effort)
          .join(", ") || "none";
        throw new LocalizedError("errors.reasoningForMustBeOneOf", { value1: prospectiveModel || "default", value2: supported });
      }
    } else if (key === "modelReasoningEffort" && clearsOption) {
      const catalog = await models.list();
      const model = effectiveModelSlug(chatKey);
      transition = planRuntimeModelReasoningTransition(catalog, model, undefined);
      if (transition.action === "reject") {
        const supported = reasoningOptionsForModel(catalog, model)
          .map(({ effort }) => effort)
          .join(", ") || "none";
        throw new LocalizedError("errors.reasoningForMustBeOneOf", { value1: model || "default", value2: supported });
      }
    }

    if (clearsOption) {
      const chat = getChatState(chatKey);
      delete chat.options[key];
      if (transition.action === "clear") delete chat.options.modelReasoningEffort;
      invalidateThreadCache(chatKey);
      return;
    }

    if (key === "modelReasoningEffort") {
      const catalog = await models.list();
      const model = effectiveModelSlug(chatKey);
      if (!isReasoningEffortSupported(catalog, model, lower)) {
        const supported = reasoningOptionsForModel(catalog, model)
          .map(({ effort }) => effort)
          .join(", ") || "none";
        throw new LocalizedError("errors.reasoningForMustBeOneOf", { value1: model || "default", value2: supported });
      }
    }

    const chat = getChatState(chatKey);
    if (key === "model") {
      chat.options.model = value;
      if (transition.action === "clear") delete chat.options.modelReasoningEffort;
    } else if (key === "workingDirectory") {
      await validation.ensureDirectory(value, "working directory");
      chat.options.workingDirectory = value;
    } else if (key === "sandboxMode") {
      assertEnum(value, validation.validSandboxModes, "sandbox");
      chat.options.sandboxMode = value;
    } else if (key === "approvalPolicy") {
      assertEnum(value, validation.validApprovalPolicies, "approval");
      chat.options.approvalPolicy = value;
    } else if (key === "modelReasoningEffort") {
      chat.options.modelReasoningEffort = lower;
    } else if (key === "webSearchMode") {
      assertEnum(value, validation.validWebSearchModes, "websearch");
      chat.options.webSearchMode = value;
    } else if (key === "serviceTier") {
      assertEnum(value, validation.validServiceTiers, "service tier");
      chat.options.serviceTier = value;
    } else if (key === "liveProgressSource") {
      assertEnum(value, validation.validLiveProgressSources, "live progress source");
      chat.options.liveProgressSource = value;
    } else if (key === "liveProgressDeletePolicy") {
      assertEnum(
        value,
        validation.validLiveProgressDeletePolicies,
        "live progress delete policy"
      );
      chat.options.liveProgressDeletePolicy = value;
    } else if (
      key === "networkAccessEnabled"
      || key === "skipGitRepoCheck"
      || key === "streamEvents"
      || key === "liveProgressEnabled"
    ) {
      chat.options[key] = validation.parseRequiredBoolean(value, key);
    } else {
      throw new LocalizedError("errors.unknownOption", { value1: key });
    }
    invalidateThreadCache(chatKey);
  }

  function invalidateThreadCache(chatKey) {
    threadCache.delete(chatKey);
    getChatState(chatKey).updatedAt = now().toISOString();
  }

  function formatModelSelectionHtml(chatKey, catalog) {
    const options = getEffectiveOptions(chatKey);
    const fastModels = catalog
      .filter((model) => model.fastSupported)
      .map((model) => model.slug);
    return [
      b(t("modelSelectionTitle")),
      msg("ui.currentModelLine", { value1: code(options.model || msg("ui.default")) }),
      msg("ui.currentThinkingLine", { value1: code(options.modelReasoningEffort) }),
      msg("ui.fastServiceTierLine", { value1: code(options.serviceTier || msg("ui.default")) }),
      "",
      t("modelSelectionDescription"),
      `${t("fastSupportedLabel")}: ${code(
        fastModels.length > 0 ? fastModels.join(", ") : msg("ui.unknown")
      )}`
    ].join("\n");
  }

  return {
    buildTurnOptions,
    defaultChatOptions,
    effectiveModelSlug,
    formatModelSelectionHtml,
    getChatState,
    getEffectiveOptions,
    invalidateThreadCache,
    planRuntimeModelReasoningTransition,
    setOption,
    updateOptionCommand,
    updateOptionValue
  };
}

function assertEnum(value, validValues, label) {
  if (!validValues.has(value)) {
    throw new LocalizedError("errors.mustBeOneOf", { value1: label, value2: [...validValues].join(", ") });
  }
}
