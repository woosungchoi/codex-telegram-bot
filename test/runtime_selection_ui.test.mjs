import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRuntimeKeyboardViews } from "../src/ui/keyboards.js";

const runtimeSource = fs.readFileSync(new URL("../src/runtime.js", import.meta.url), "utf8");

function extractBlock(start) {
  assert.notEqual(start, -1, "runtime block must exist");
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
  const marker = `function ${name}(`;
  const start = runtimeSource.indexOf(marker);
  assert.notEqual(start, -1, `${name} must exist in runtime.js`);
  const asyncStart = runtimeSource.lastIndexOf("async ", start);
  return extractBlock(asyncStart === start - 6 ? asyncStart : start);
}

function commandHandler(command) {
  const marker = `bot.command("${command}"`;
  return extractBlock(runtimeSource.indexOf(marker));
}

function actionHandler(marker) {
  const registration = runtimeSource.indexOf(marker);
  assert.notEqual(registration, -1, `${marker} action must exist`);
  return extractBlock(runtimeSource.indexOf("async (ctx) =>", registration));
}

const keyboardViews = createRuntimeKeyboardViews({
  text: (key) => key === "close" ? "Close" : key,
  hasActiveTurn: () => false,
  sideTurnCount: () => 0,
  currentLanguage: () => "en",
  currentTimeZone: () => "UTC",
  currentLocale: () => "en-US"
});

test("standalone model and reasoning commands start isolated cancellable flows", () => {
  assert.match(commandHandler("model"), /sendStandaloneModelSelection/);
  assert.match(commandHandler("reasoning"), /sendStandaloneReasoningSelection/);

  const session = { token: "abc123" };
  const modelButtons = keyboardViews
    .standaloneModelSelectionKeyboard([{ slug: "model", displayName: "Model" }], session)
    .reply_markup.inline_keyboard.flat();
  const reasoningButtons = keyboardViews
    .standaloneReasoningSelectionKeyboard([{ effort: "high" }], session)
    .reply_markup.inline_keyboard.flat();
  assert.ok(modelButtons.some(({ callback_data: callbackData }) => callbackData === "m:abc123:model"));
  assert.ok(reasoningButtons.some(({ callback_data: callbackData }) => callbackData === "r:abc123:high"));
  for (const buttons of [modelButtons, reasoningButtons]) {
    assert.ok(buttons.some(({ callback_data: callbackData }) => callbackData === "x:abc123"));
    assert.ok(buttons.every(({ callback_data: callbackData }) => !["p:settings", "p:main"].includes(callbackData)));
  }
});

test("standalone callbacks delegate to model selection controller handlers", () => {
  const modelAction = actionHandler("bot.action(/^m:");
  const reasoningAction = actionHandler("bot.action(/^r:");
  const fastAction = actionHandler("bot.action(/^f:");
  assert.match(modelAction, /handleStandaloneModelSelection/);
  assert.match(reasoningAction, /handleStandaloneReasoningSelection/);
  assert.match(fastAction, /handleStandaloneFastSelection/);
});

test("selection cancel and menu close use strict edits and remove every button", () => {
  assert.match(actionHandler("bot.action(/^x:"), /handleStandaloneSelectionCancel/);
  assert.match(actionHandler('bot.action("ui:close:menu"'), /handleMenuClose/);

  const mainButtons = keyboardViews.mainPanelKeyboard("chat").reply_markup.inline_keyboard.flat();
  assert.ok(mainButtons.some(({ text, callback_data: callbackData }) => (
    text === "Close" && callbackData === "ui:close:menu"
  )));
});

test("menu close decoration is immutable, idempotent, unique, and last", () => {
  const { withMenuCloseButton } = keyboardViews;
  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Main", callback_data: "p:main" },
          { text: "Old close", callback_data: "ui:close:menu" }
        ],
        [{ text: "Back", callback_data: "p:settings" }],
        [{ text: "Duplicate close", callback_data: "ui:close:menu" }]
      ]
    }
  };
  const original = JSON.parse(JSON.stringify(keyboard));

  const decorated = withMenuCloseButton(keyboard);
  assert.deepEqual(keyboard, original);
  assert.deepEqual(decorated.reply_markup.inline_keyboard, [
    [{ text: "Main", callback_data: "p:main" }],
    [{ text: "Back", callback_data: "p:settings" }],
    [{ text: "Close", callback_data: "ui:close:menu" }]
  ]);
  assert.deepEqual(withMenuCloseButton(decorated), decorated);
});

test("stable menu stages are closable while standalone and processing flows are not", () => {
  for (const name of ["queueKeyboard", "withToolsBack", "codexMaintenanceKeyboard"]) {
    assert.match(runtimeFunction(name), /withMenuCloseButton/, `${name} must include menu close`);
  }
  for (const keyboard of [
    keyboardViews.statusKeyboard("chat"),
    keyboardViews.settingsKeyboard(),
    keyboardViews.settingsSelectionKeyboard(keyboardViews.emptyInlineKeyboard(), "settings"),
    keyboardViews.runtimeKeyboard(),
    keyboardViews.runtimeCodexKeyboard(),
    keyboardViews.backToMainKeyboard()
  ]) {
    const buttons = keyboard.reply_markup.inline_keyboard.flat();
    assert.equal(buttons.filter(({ callback_data: callbackData }) => callbackData === "ui:close:menu").length, 1);
  }

  const sendPanelStart = runtimeSource.indexOf("async function sendPanel");
  const sendPanelEnd = runtimeSource.indexOf("async function formatMainPanelHtml", sendPanelStart);
  assert.match(runtimeSource.slice(sendPanelStart, sendPanelEnd), /withMenuCloseButton\(withPreviousPanelButton/);
  assert.match(runtimeFunction("handleQueueButton"), /withMenuCloseButton\(inlineKeyboard/);
  assert.match(runtimeFunction("handleToolButton"), /withMenuCloseButton\(inlineKeyboard/);

  const usageHandler = runtimeFunction("handleUsageRefreshButton");
  assert.match(usageHandler, /withMenuCloseButton\(inlineKeyboard/);
  assert.equal(usageHandler.match(/closable: false/g)?.length, 3);

  const selectionButtons = keyboardViews
    .withSelectionCancel(keyboardViews.emptyInlineKeyboard(), { token: "abc123" })
    .reply_markup.inline_keyboard.flat();
  assert.ok(selectionButtons.every(({ callback_data: callbackData }) => callbackData !== "ui:close:menu"));

  for (const name of [
    "codexMaintenanceBusyKeyboard",
    "cleanupKeyboard",
    "editCleanupProcessingMessage",
    "uploadCleanupKeyboard"
  ]) {
    assert.doesNotMatch(runtimeFunction(name), /withMenuCloseButton|ui:close:menu/, `${name} must stay outside menu close`);
  }
});

test("strict selection edits disable replacement replies", () => {
  const strictEdit = runtimeFunction("editSelectionMessageStrict");
  assert.match(strictEdit, /replyOnUnavailable: false/);
  assert.match(strictEdit, /summarizeTelegramError/);
});

test("settings model flow edits through reasoning and optional Fast with panel navigation", () => {
  const modelAction = actionHandler("bot.action(/^model:set:");
  const reasoningAction = actionHandler("bot.action(/^reasoning:set:");
  const modelReasoningAction = actionHandler("bot.action(/^rm:");
  assert.match(modelAction, /handleSettingsModelSelection/);
  assert.match(reasoningAction, /handleSettingsReasoningSelection/);
  assert.match(modelReasoningAction, /handleSettingsReasoningSelection/);
  assert.match(modelReasoningAction, /continueToFast: true/);

  const navigation = keyboardViews
    .settingsSelectionKeyboard(keyboardViews.emptyInlineKeyboard(), "settings_model")
    .reply_markup.inline_keyboard.flat();
  assert.ok(navigation.some(({ callback_data: callbackData }) => callbackData === "p:settings"));
  assert.ok(navigation.some(({ callback_data: callbackData }) => callbackData === "p:main"));
  assert.ok(navigation.some(({ callback_data: callbackData, text }) => (
    callbackData === "p:settings_model" && text.includes("←")
  )));
});
