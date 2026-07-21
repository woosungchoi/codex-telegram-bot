import test from "node:test";
import assert from "node:assert/strict";
import { createChatOptionsController } from "../src/codex/chat_options_controller.js";
import {
  createAtomicChatOptionsReplacer,
  createModelSelectionController
} from "../src/ui/model_selection_controller.js";

const MODELS = [
  {
    slug: "gpt-5.6-sol",
    fastSupported: true,
    supportedReasoning: ["high", "ultra"].map((effort) => ({ effort, description: "" }))
  },
  {
    slug: "gpt-5.6-luna",
    fastSupported: false,
    supportedReasoning: [{ effort: "high", description: "" }]
  },
  { slug: "known-empty", supportedReasoning: [] }
];

function createHarness(configuredReasoning, initialOptions, configuredModel = "gpt-5.6-sol") {
  const state = { chats: { chat: { options: { ...initialOptions }, updatedAt: "before" } } };
  const threadCache = new Map([["chat", { id: "cached" }]]);
  const counters = { saves: 0, callbackAnswers: 0, replies: [] };
  const listModels = async () => MODELS;
  const replyHtml = async (_ctx, html) => {
    counters.replies.push(html);
  };
  const options = createChatOptionsController({
    settings: {
      workingDirectory: "/workspace",
      skipGitRepoCheck: false,
      approvalPolicy: "on-request",
      sandboxMode: "workspace-write",
      reasoningEffort: configuredReasoning,
      webSearchMode: "disabled",
      liveProgressEnabled: () => false,
      liveProgressSource: "agent",
      liveProgressDeletePolicy: "on_success",
      model: configuredModel,
      additionalDirectories: [],
      uploadDir: "/uploads"
    },
    stateStore: {
      chats: state.chats,
      save: async () => {
        counters.saves += 1;
      }
    },
    threadCache,
    models: { list: listModels },
    telegram: {
      commandName: () => "model",
      formatOptionsHtml: () => "options",
      getChatKey: () => "chat",
      getCommandArgs: () => "",
      rejectIfActive: async () => false,
      replyHtml
    },
    validation: {
      ensureDirectory: async () => {},
      parseRequiredBoolean: (value) => value === "on",
      validApprovalPolicies: new Set(["on-request"]),
      validLiveProgressDeletePolicies: new Set(["on_success"]),
      validLiveProgressSources: new Set(["agent"]),
      validSandboxModes: new Set(["workspace-write"]),
      validServiceTiers: new Set(["fast", "flex"]),
      validWebSearchModes: new Set(["disabled", "cached", "live"])
    },
    text: () => "selection help"
  });
  const replaceOptions = createAtomicChatOptionsReplacer({
    getChat: options.getChatState,
    save: () => counters.saves += 1,
    invalidate: (chatKey) => threadCache.delete(chatKey),
    now: () => "after"
  });
  const controller = createModelSelectionController({
    flowStore: {
      begin: () => {},
      finish: () => {},
      read: () => null,
      update: () => null
    },
    models: {
      list: listModels,
      defaultSlug: () => configuredModel,
      planTransition: options.planRuntimeModelReasoningTransition
    },
    chat: {
      keyFromContext: () => "chat",
      getOptions: (chatKey) => options.getChatState(chatKey).options,
      replaceOptions,
      isActive: () => false,
      rejectIfActive: async () => false,
      effectiveModelSlug: options.effectiveModelSlug
    },
    telegram: {
      replyHtml,
      editOrReplyHtml: async (_ctx, html) => {
        counters.replies.push(html);
      },
      editStrict: async () => true,
      answerUiCallback: async () => {}
    },
    views: {
      formatModelSelectionHtml: options.formatModelSelectionHtml,
      formatReasoningPromptHtml: () => "reasoning",
      settingsSelectionKeyboard: () => ({}),
      fastPanelHtml: async () => "fast",
      fastKeyboard: () => ({})
    },
    text: () => "selection help"
  });
  const modelAction = async (ctx) => {
    await controller.handleSettingsModelSelection(ctx, ctx.match[1]);
    await ctx.answerCbQuery().catch(() => {});
  };
  const reasoningAction = async (ctx) => {
    await controller.handleSettingsReasoningSelection(ctx, ctx.match[1]);
    await ctx.answerCbQuery().catch(() => {});
  };
  return {
    state,
    counters,
    threadCache,
    command: options.updateOptionValue,
    settingsReasoning: controller.handleSettingsReasoningSelection,
    modelAction,
    reasoningAction,
    ctx(value) {
      return {
        match: ["", value],
        answerCbQuery: async () => {
          counters.callbackAnswers += 1;
        }
      };
    }
  };
}

function observable(harness) {
  return {
    options: { ...harness.state.chats.chat.options },
    updatedAt: harness.state.chats.chat.updatedAt,
    saves: harness.counters.saves,
    invalidated: !harness.threadCache.has("chat")
  };
}

function assertRejected(harness, options) {
  assert.deepEqual(observable(harness), {
    options,
    updatedAt: "before",
    saves: 0,
    invalidated: false
  });
}

test("setOption commands reject incompatible prospective pairs before mutation", async () => {
  for (const initialOptions of [
    { model: "gpt-5.6-sol", modelReasoningEffort: "ultra" },
    { model: "gpt-5.6-sol" }
  ]) {
    const harness = createHarness("ultra", initialOptions);
    await harness.command(harness.ctx(""), "model", "gpt-5.6-luna");
    assertRejected(harness, initialOptions);
  }

  for (const clearValue of ["default", "off", "clear"]) {
    const reasoningDefault = createHarness("ultra", {
      model: "gpt-5.6-luna",
      modelReasoningEffort: "high"
    });
    await reasoningDefault.command(reasoningDefault.ctx(""), "modelReasoningEffort", clearValue);
    assertRejected(reasoningDefault, { model: "gpt-5.6-luna", modelReasoningEffort: "high" });
  }

  for (const clearValue of ["default", "off", "clear"]) {
    const modelDefault = createHarness("ultra", { model: "gpt-5.6-sol" }, "gpt-5.6-luna");
    await modelDefault.command(modelDefault.ctx(""), "model", clearValue);
    assertRejected(modelDefault, { model: "gpt-5.6-sol" });
  }

  const knownEmpty = createHarness("high", {
    model: "gpt-5.6-sol",
    modelReasoningEffort: "high"
  });
  await knownEmpty.command(knownEmpty.ctx(""), "model", "known-empty");
  assertRejected(knownEmpty, { model: "gpt-5.6-sol", modelReasoningEffort: "high" });
});

test("setOption commands clear only onto a supported baseline and preserve custom models", async () => {
  const cleared = createHarness("high", {
    model: "gpt-5.6-sol",
    modelReasoningEffort: "ultra"
  });
  await cleared.command(cleared.ctx(""), "model", "gpt-5.6-luna");
  assert.equal(cleared.state.chats.chat.options.model, "gpt-5.6-luna");
  assert.equal(Object.hasOwn(cleared.state.chats.chat.options, "modelReasoningEffort"), false);
  assert.equal(cleared.counters.saves, 1);
  assert.equal(cleared.threadCache.has("chat"), false);

  const custom = createHarness("ultra", {
    model: "gpt-5.6-sol",
    modelReasoningEffort: "ultra"
  });
  await custom.command(custom.ctx(""), "model", "custom-model");
  assert.deepEqual(custom.state.chats.chat.options, {
    model: "custom-model",
    modelReasoningEffort: "ultra"
  });
  assert.equal(custom.counters.saves, 1);
  assert.equal(custom.threadCache.has("chat"), false);
});

test("model and reasoning callbacks enforce the same transactional boundary", async () => {
  for (const initialOptions of [
    { model: "gpt-5.6-sol", modelReasoningEffort: "ultra" },
    { model: "gpt-5.6-sol" }
  ]) {
    const harness = createHarness("ultra", initialOptions);
    await harness.modelAction(harness.ctx("gpt-5.6-luna"));
    assertRejected(harness, initialOptions);
    assert.equal(harness.counters.callbackAnswers, 1);
  }

  const reasoningDefault = createHarness("ultra", {
    model: "gpt-5.6-luna",
    modelReasoningEffort: "high"
  });
  await reasoningDefault.reasoningAction(reasoningDefault.ctx("default"));
  assertRejected(reasoningDefault, { model: "gpt-5.6-luna", modelReasoningEffort: "high" });

  const modelDefault = createHarness("ultra", { model: "gpt-5.6-sol" }, "gpt-5.6-luna");
  await modelDefault.modelAction(modelDefault.ctx("default"));
  assertRejected(modelDefault, { model: "gpt-5.6-sol" });

  const unavailable = createHarness("high", { model: "gpt-5.6-sol" });
  await unavailable.modelAction(unavailable.ctx("missing-model"));
  assertRejected(unavailable, { model: "gpt-5.6-sol" });
  assert.match(unavailable.counters.replies.at(-1), /Current model: <code>gpt-5\.6-sol<\/code>/);
  assert.match(unavailable.counters.replies.at(-1), /Current thinking: <code>high<\/code>/);
  assert.match(unavailable.counters.replies.at(-1), /Fast service tier: <code>default<\/code>/);

  const cleared = createHarness("high", {
    model: "gpt-5.6-sol",
    modelReasoningEffort: "ultra"
  });
  await cleared.modelAction(cleared.ctx("gpt-5.6-luna"));
  assert.equal(cleared.state.chats.chat.options.model, "gpt-5.6-luna");
  assert.equal(Object.hasOwn(cleared.state.chats.chat.options, "modelReasoningEffort"), false);
  assert.equal(cleared.counters.saves, 1);
  assert.equal(cleared.threadCache.has("chat"), false);
});

test("settings model flow clears stale Fast and offers Fast only after compatible reasoning", async () => {
  const nonFast = createHarness("high", {
    model: "gpt-5.6-sol",
    modelReasoningEffort: "high",
    serviceTier: "fast"
  });
  await nonFast.modelAction(nonFast.ctx("gpt-5.6-luna"));
  assert.deepEqual(nonFast.state.chats.chat.options, {
    model: "gpt-5.6-luna",
    modelReasoningEffort: "high"
  });

  const fast = createHarness("high", {
    model: "gpt-5.6-sol",
    modelReasoningEffort: "high"
  });
  await fast.settingsReasoning(fast.ctx("ultra"), "ultra", { continueToFast: true });
  assert.equal(fast.state.chats.chat.options.modelReasoningEffort, "ultra");
  assert.match(fast.counters.replies.at(-1), /fast/);
});
