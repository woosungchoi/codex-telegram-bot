import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { findCodexModel, reasoningOptionsForModel } from "../src/codex/models.js";
import {
  applyModelSelectionDraft,
  applyReasoningSelection,
  createSelectionFlowStore
} from "../src/ui/model_selection_flow.js";

const runtimeSource = fs.readFileSync(new URL("../src/runtime.js", import.meta.url), "utf8");
const MODELS = [
  {
    slug: "gpt-fast",
    displayName: "Fast",
    fastSupported: true,
    supportedReasoning: ["high", "ultra"].map((effort) => ({ effort, description: "" }))
  },
  {
    slug: "gpt-standard",
    displayName: "Standard",
    fastSupported: false,
    supportedReasoning: [{ effort: "high", description: "" }]
  }
];

function extractBlock(start) {
  assert.notEqual(start, -1, "runtime block must exist");
  const open = runtimeSource.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < runtimeSource.length; index += 1) {
    if (runtimeSource[index] === "{") depth += 1;
    if (runtimeSource[index] === "}") depth -= 1;
    if (depth === 0) return runtimeSource.slice(start, index + 1);
  }
  throw new Error("runtime block closing brace must exist");
}

function runtimeFunction(name) {
  const marker = `function ${name}(`;
  const start = runtimeSource.indexOf(marker);
  assert.notEqual(start, -1, `${name} must exist in runtime.js`);
  const asyncStart = runtimeSource.lastIndexOf("async ", start);
  return extractBlock(asyncStart === start - 6 ? asyncStart : start);
}

const declarations = [
  runtimeFunction("handleStandaloneModelSelection"),
  runtimeFunction("handleStandaloneReasoningSelection"),
  runtimeFunction("handleStandaloneFastSelection"),
  runtimeFunction("handleStandaloneSelectionCancel"),
  runtimeFunction("handleMenuClose"),
  runtimeFunction("standaloneSelectionSession"),
  runtimeFunction("answerSelectionExpiredCallback"),
  runtimeFunction("rejectStandaloneSelectionIfActive"),
  runtimeFunction("commitStandaloneModelSelection"),
  runtimeFunction("commitStandaloneReasoningSelection"),
  runtimeFunction("replaceChatOptionsAtomically")
].join("\n");

const moduleSource = `
export function createRuntimeBindings(context) {
  const {
    selectionFlows, activeTurns, getChatKey, listCodexModels, editSelectionMessageStrict,
    answerUiCallback, answerSelectionText, b, code, t, formatModelSelectionHtml,
    formatStandaloneReasoningPromptHtml, formatStandaloneFastPromptHtml,
    formatStandaloneSelectionResultHtml, standaloneModelSelectionKeyboard,
    standaloneReasoningSelectionKeyboard, standaloneFastSelectionKeyboard,
    emptyInlineKeyboard, reasoningOptionsForModel, standaloneReasoningChoiceSupported,
    findCodexModel, config, getChatState, applyModelSelectionDraft,
    applyReasoningSelection, saveState, state, threadCache
  } = context;
  ${declarations}
  return {
    model: handleStandaloneModelSelection,
    reasoning: handleStandaloneReasoningSelection,
    fast: handleStandaloneFastSelection,
    cancel: handleStandaloneSelectionCancel,
    closeMenu: handleMenuClose
  };
}`;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(moduleSource).toString("base64")}`;
const { createRuntimeBindings } = await import(moduleUrl);

function createHarness(initialOptions = {}, options = {}) {
  let tokenNumber = 0;
  const selectionFlows = createSelectionFlowStore({
    tokenFactory: () => (++tokenNumber).toString(16).padStart(6, "0"),
    now: options.now ?? (() => 1_000),
    maxAgeMs: options.maxAgeMs
  });
  const state = {
    chats: {
      chat: { options: { ...initialOptions }, updatedAt: "before" }
    }
  };
  const edits = [];
  const answers = [];
  const counters = { saves: 0 };
  let editSucceeds = true;
  let saveFails = options.saveFails === true;
  const activeTurns = new Map();
  const context = {
    selectionFlows,
    activeTurns,
    getChatKey: () => "chat",
    listCodexModels: async () => MODELS,
    editSelectionMessageStrict: async (_ctx, html, extra) => {
      edits.push({ html, extra });
      return editSucceeds;
    },
    answerUiCallback: async (ctx, edited) => {
      await ctx.answerCbQuery(edited ? undefined : "selectionUpdateFailed", edited ? undefined : { show_alert: true });
    },
    answerSelectionText: async () => {},
    b: String,
    code: String,
    t: (key) => key,
    formatModelSelectionHtml: () => "model prompt",
    formatStandaloneReasoningPromptHtml: () => "reasoning prompt",
    formatStandaloneFastPromptHtml: () => "fast prompt",
    formatStandaloneSelectionResultHtml: () => "selection result",
    standaloneModelSelectionKeyboard: () => ({ stage: "model" }),
    standaloneReasoningSelectionKeyboard: () => ({ stage: "reasoning" }),
    standaloneFastSelectionKeyboard: () => ({ stage: "fast" }),
    emptyInlineKeyboard: () => ({ reply_markup: { inline_keyboard: [] } }),
    reasoningOptionsForModel,
    standaloneReasoningChoiceSupported: (models, model, reasoning) => (
      reasoning === "default"
      || reasoningOptionsForModel(models, model).some(({ effort }) => effort === reasoning)
    ),
    findCodexModel,
    config: { codexModel: "gpt-fast", stateFile: "/unused/state.json" },
    getChatState: () => state.chats.chat,
    applyModelSelectionDraft,
    applyReasoningSelection,
    saveState: async () => {
      counters.saves += 1;
      if (saveFails) throw new Error("save failed");
    },
    state,
    threadCache: new Map([["chat", { id: "cached" }]])
  };
  const handlers = createRuntimeBindings(context);

  return {
    ...handlers,
    state,
    selectionFlows,
    edits,
    answers,
    counters,
    activeTurns,
    setEditSucceeds(value) {
      editSucceeds = value;
    },
    setSaveFails(value) {
      saveFails = value;
    },
    ctx() {
      return {
        answerCbQuery: async (text, extra) => {
          answers.push({ text, extra });
        }
      };
    }
  };
}

test("standalone model commits model, reasoning, and Fast only after the final choice", async () => {
  const harness = createHarness({ model: "old", modelReasoningEffort: "low" });
  const session = harness.selectionFlows.begin("chat", "model");

  await harness.model(harness.ctx(), session.token, "gpt-fast");
  assert.deepEqual(harness.state.chats.chat.options, {
    model: "old",
    modelReasoningEffort: "low"
  });
  assert.equal(harness.selectionFlows.read("chat", session.token).phase, "reasoning");
  assert.equal(harness.edits.at(-1).extra.stage, "reasoning");

  await harness.reasoning(harness.ctx(), session.token, "ultra");
  assert.equal(harness.counters.saves, 0);
  assert.equal(harness.selectionFlows.read("chat", session.token).phase, "fast");
  assert.equal(harness.edits.at(-1).extra.stage, "fast");

  await harness.fast(harness.ctx(), session.token, "on");
  assert.deepEqual(harness.state.chats.chat.options, {
    model: "gpt-fast",
    modelReasoningEffort: "ultra",
    serviceTier: "fast"
  });
  assert.equal(harness.counters.saves, 1);
  assert.equal(harness.selectionFlows.read("chat", session.token), null);
  assert.deepEqual(harness.edits.at(-1).extra.reply_markup.inline_keyboard, []);
});

test("cancel at model, reasoning, or Fast phase removes buttons without saving", async () => {
  for (const phase of ["model", "reasoning", "fast"]) {
    const initial = { model: "old", modelReasoningEffort: "low", serviceTier: "flex" };
    const harness = createHarness(initial);
    const session = harness.selectionFlows.begin("chat", "model");
    if (phase !== "model") await harness.model(harness.ctx(), session.token, "gpt-fast");
    if (phase === "fast") await harness.reasoning(harness.ctx(), session.token, "high");

    await harness.cancel(harness.ctx(), session.token);
    assert.deepEqual(harness.state.chats.chat.options, initial);
    assert.equal(harness.counters.saves, 0);
    assert.equal(harness.selectionFlows.read("chat", session.token), null);
    assert.equal(harness.edits.at(-1).html, "modelSelectionCancelled");
    assert.deepEqual(harness.edits.at(-1).extra.reply_markup.inline_keyboard, []);
  }
});

test("standalone reasoning updates only reasoning and a non-Fast model clears stale Fast", async () => {
  const reasoning = createHarness({ model: "gpt-fast", serviceTier: "fast", modelReasoningEffort: "high" });
  const reasoningSession = reasoning.selectionFlows.begin("chat", "reasoning", { modelSlug: "gpt-fast" });
  await reasoning.reasoning(reasoning.ctx(), reasoningSession.token, "ultra");
  assert.deepEqual(reasoning.state.chats.chat.options, {
    model: "gpt-fast",
    serviceTier: "fast",
    modelReasoningEffort: "ultra"
  });

  const model = createHarness({ model: "gpt-fast", serviceTier: "fast", modelReasoningEffort: "ultra" });
  const modelSession = model.selectionFlows.begin("chat", "model");
  await model.model(model.ctx(), modelSession.token, "gpt-standard");
  await model.reasoning(model.ctx(), modelSession.token, "high");
  assert.deepEqual(model.state.chats.chat.options, {
    model: "gpt-standard",
    modelReasoningEffort: "high"
  });
  assert.equal(model.selectionFlows.read("chat", modelSession.token), null);
});

test("duplicate callbacks are rejected without discarding the advanced selection", async () => {
  const harness = createHarness();
  const session = harness.selectionFlows.begin("chat", "model");
  await harness.model(harness.ctx(), session.token, "gpt-fast");
  const editCount = harness.edits.length;

  await harness.model(harness.ctx(), session.token, "gpt-fast");
  assert.equal(harness.selectionFlows.read("chat", session.token).phase, "reasoning");
  assert.equal(harness.edits.length, editCount);
  assert.equal(harness.answers.at(-1).text, "selectionExpired");
  assert.equal(harness.answers.at(-1).extra.show_alert, true);
});

test("expired callbacks clear stale buttons and committing selections cannot report cancellation", async () => {
  let currentTime = 1_000;
  const expired = createHarness({}, { now: () => currentTime, maxAgeMs: 100 });
  const expiredSession = expired.selectionFlows.begin("chat", "model");
  currentTime = 1_101;
  await expired.cancel(expired.ctx(), expiredSession.token);
  assert.equal(expired.edits.at(-1).html, "selectionExpired");
  assert.deepEqual(expired.edits.at(-1).extra.reply_markup.inline_keyboard, []);

  const committing = createHarness();
  const committingSession = committing.selectionFlows.begin("chat", "model");
  committing.selectionFlows.update("chat", committingSession.token, "model", { phase: "committing" });
  await committing.cancel(committing.ctx(), committingSession.token);
  assert.equal(committing.selectionFlows.read("chat", committingSession.token).phase, "committing");
  assert.equal(committing.edits.length, 0);
  assert.equal(committing.answers.at(-1).text, "selectionFinalizing");
});

test("edit and save failures keep the previous options and a cancellable phase", async () => {
  const editFailure = createHarness({ model: "old" });
  const editSession = editFailure.selectionFlows.begin("chat", "model");
  editFailure.setEditSucceeds(false);
  await editFailure.model(editFailure.ctx(), editSession.token, "gpt-fast");
  assert.equal(editFailure.selectionFlows.read("chat", editSession.token).phase, "model");
  assert.deepEqual(editFailure.state.chats.chat.options, { model: "old" });

  const saveFailure = createHarness({ model: "old", modelReasoningEffort: "low" }, { saveFails: true });
  const saveSession = saveFailure.selectionFlows.begin("chat", "model");
  await saveFailure.model(saveFailure.ctx(), saveSession.token, "gpt-standard");
  await saveFailure.reasoning(saveFailure.ctx(), saveSession.token, "high");
  assert.deepEqual(saveFailure.state.chats.chat.options, {
    model: "old",
    modelReasoningEffort: "low"
  });
  assert.equal(saveFailure.selectionFlows.read("chat", saveSession.token).phase, "reasoning");
  assert.equal(saveFailure.edits.at(-1).extra.stage, "reasoning");
});

test("menu close edits to closed copy and removes the entire keyboard", async () => {
  const harness = createHarness();
  harness.activeTurns.set("chat", { id: "active" });
  await harness.closeMenu(harness.ctx());
  assert.equal(harness.edits.at(-1).html, "menuClosed");
  assert.deepEqual(harness.edits.at(-1).extra.reply_markup.inline_keyboard, []);
});
