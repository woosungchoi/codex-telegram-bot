import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  isReasoningEffortSupported,
  reasoningOptionsForModel
} from "../src/codex/models.js";
import {
  createAtomicChatOptionsReplacer,
  createModelSelectionController
} from "../src/ui/model_selection_controller.js";

const runtimeSource = fs.readFileSync(new URL("../src/runtime.js", import.meta.url), "utf8");
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

function extractBlock(start) {
  const open = runtimeSource.indexOf("{", start);
  assert.notEqual(open, -1, "runtime block opening brace must exist");
  let depth = 0;
  for (let index = open; index < runtimeSource.length; index += 1) {
    if (runtimeSource[index] === "{") depth += 1;
    if (runtimeSource[index] === "}") depth -= 1;
    if (depth === 0) return runtimeSource.slice(start, index + 1);
  }
  throw new Error("runtime block closing brace must exist");
}

function runtimeFunction(name) {
  const start = runtimeSource.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist in runtime.js`);
  const asyncStart = runtimeSource.lastIndexOf("async ", start);
  return extractBlock(asyncStart === start - 6 ? asyncStart : start);
}

function runtimeOptionsImport() {
  const marker = 'from "./codex/options.js";';
  const end = runtimeSource.indexOf(marker);
  assert.notEqual(end, -1, "runtime options import must exist");
  const start = runtimeSource.lastIndexOf("import ", end);
  const source = runtimeSource.slice(start, end + marker.length);
  return source.replace("./codex/options.js", new URL("../src/codex/options.js", import.meta.url).href);
}

const declarations = [
  runtimeFunction("defaultChatOptions"),
  runtimeFunction("getEffectiveOptions"),
  runtimeFunction("effectiveModelSlug"),
  runtimeFunction("planRuntimeModelReasoningTransition"),
  runtimeFunction("getChatState"),
  runtimeFunction("invalidateThreadCache"),
  runtimeFunction("setOption"),
  runtimeFunction("updateOptionValue"),
  runtimeFunction("formatModelSelectionHtml")
].join("\n");
const moduleSource = `${runtimeOptionsImport()}
export function createRuntimeBindings(context) {
  const { state, threadCache, config, listCodexModels, getChatKey,
    isReasoningEffortSupported, reasoningOptionsForModel, rejectIfActive,
    saveState, replyHtml, code, b, t, runtimeValue, formatOptionsHtml } = context;
  ${declarations}
  return {
    command: updateOptionValue,
    effectiveModelSlug,
    formatModelSelectionHtml,
    getChatState,
    planRuntimeModelReasoningTransition
  };
}`;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(moduleSource).toString("base64")}`;
const { createRuntimeBindings } = await import(moduleUrl);

function createHarness(configuredReasoning, initialOptions, configuredModel = "gpt-5.6-sol") {
  const state = { chats: { chat: { options: { ...initialOptions }, updatedAt: "before" } } };
  const threadCache = new Map([["chat", { id: "cached" }]]);
  const counters = { saves: 0, callbackAnswers: 0, replies: [] };
  const context = {
    state,
    threadCache,
    config: {
      codexModel: configuredModel,
      codexReasoningEffort: configuredReasoning,
      stateFile: "/unused/state.json"
    },
    listCodexModels: async () => MODELS,
    getChatKey: () => "chat",
    isReasoningEffortSupported,
    reasoningOptionsForModel,
    rejectIfActive: async () => false,
    saveState: async () => { counters.saves += 1; },
    replyHtml: async (_ctx, html) => { counters.replies.push(html); },
    code: String,
    b: String,
    t: () => "selection help",
    runtimeValue: () => false,
    formatOptionsHtml: () => "options"
  };
  const bindings = createRuntimeBindings(context);
  const replaceOptions = createAtomicChatOptionsReplacer({
    getChat: bindings.getChatState,
    save: () => context.saveState(),
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
      list: context.listCodexModels,
      defaultSlug: () => configuredModel,
      planTransition: bindings.planRuntimeModelReasoningTransition
    },
    chat: {
      keyFromContext: context.getChatKey,
      getOptions: (chatKey) => bindings.getChatState(chatKey).options,
      replaceOptions,
      isActive: () => false,
      rejectIfActive: async () => false,
      effectiveModelSlug: bindings.effectiveModelSlug
    },
    telegram: {
      replyHtml: context.replyHtml,
      editOrReplyHtml: async (_ctx, html) => { counters.replies.push(html); },
      editStrict: async () => true,
      answerUiCallback: async () => {}
    },
    views: {
      formatModelSelectionHtml: bindings.formatModelSelectionHtml,
      formatReasoningPromptHtml: () => "reasoning",
      settingsSelectionKeyboard: () => ({}),
      fastPanelHtml: async () => "fast",
      fastKeyboard: () => ({})
    },
    text: context.t
  });
  const modelAction = async (ctx) => {
    await controller.handleSettingsModelSelection(ctx, ctx.match[1]);
    await ctx.answerCbQuery().catch(() => {});
  };
  const reasoningAction = async (ctx) => {
    await controller.handleSettingsReasoningSelection(ctx, ctx.match[1]);
    await ctx.answerCbQuery().catch(() => {});
  };
  const settingsReasoning = controller.handleSettingsReasoningSelection;
  const { command } = bindings;
  return {
    state,
    counters,
    threadCache,
    command,
    settingsReasoning,
    modelAction,
    reasoningAction,
    ctx(value) {
      return {
        match: ["", value],
        answerCbQuery: async () => { counters.callbackAnswers += 1; }
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
    options, updatedAt: "before", saves: 0, invalidated: false
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
  assert.match(unavailable.counters.replies.at(-1), /Current model: gpt-5\.6-sol/);
  assert.match(unavailable.counters.replies.at(-1), /Current thinking: high/);
  assert.match(unavailable.counters.replies.at(-1), /Fast service tier: default/);

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
