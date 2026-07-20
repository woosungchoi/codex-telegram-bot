import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

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

test("standalone model and reasoning commands start isolated cancellable flows", () => {
  assert.match(commandHandler("model"), /sendStandaloneModelSelection/);
  assert.match(commandHandler("reasoning"), /sendStandaloneReasoningSelection/);

  const modelKeyboard = runtimeFunction("standaloneModelSelectionKeyboard");
  const reasoningKeyboard = runtimeFunction("standaloneReasoningSelectionKeyboard");
  assert.match(modelKeyboard, /m:\$\{session\.token\}:/);
  assert.match(reasoningKeyboard, /r:\$\{session\.token\}:/);
  assert.match(modelKeyboard, /withSelectionCancel/);
  assert.match(reasoningKeyboard, /withSelectionCancel/);
  assert.doesNotMatch(modelKeyboard, /p:settings|p:main|settingsSelectionKeyboard/);
  assert.doesNotMatch(reasoningKeyboard, /p:settings|p:main|settingsSelectionKeyboard/);
});

test("standalone callbacks edit one message and commit only after the final step", () => {
  const modelAction = actionHandler("bot.action(/^m:");
  const reasoningAction = actionHandler("bot.action(/^r:");
  const fastAction = actionHandler("bot.action(/^f:");
  assert.match(modelAction, /handleStandaloneModelSelection/);
  assert.match(reasoningAction, /handleStandaloneReasoningSelection/);
  assert.match(fastAction, /handleStandaloneFastSelection/);

  const modelHandler = runtimeFunction("handleStandaloneModelSelection");
  assert.match(modelHandler, /editSelectionMessageStrict/);
  assert.match(modelHandler, /selectionFlows\.update/);
  assert.doesNotMatch(modelHandler, /saveState|replyHtml/);

  const reasoningHandler = runtimeFunction("handleStandaloneReasoningSelection");
  assert.match(reasoningHandler, /processing\.kind === "model"/);
  assert.match(reasoningHandler, /processing\.fastSupported/);
  assert.match(reasoningHandler, /phase: "committing"/);
  assert.match(reasoningHandler, /commitStandaloneModelSelection/);
  assert.match(reasoningHandler, /commitStandaloneReasoningSelection/);
  assert.doesNotMatch(reasoningHandler, /replyHtml/);

  const fastHandler = runtimeFunction("handleStandaloneFastSelection");
  assert.match(fastHandler, /commitStandaloneModelSelection/);
  assert.match(fastHandler, /phase: "committing"/);
  assert.doesNotMatch(fastHandler, /replyHtml/);
});

test("selection cancel and menu close use strict edits and remove every button", () => {
  const cancelHandler = runtimeFunction("handleStandaloneSelectionCancel");
  assert.match(cancelHandler, /selectionFlows\.finish/);
  assert.match(cancelHandler, /modelSelectionCancelled/);
  assert.match(cancelHandler, /reasoningSelectionCancelled/);
  assert.match(cancelHandler, /emptyInlineKeyboard/);
  assert.match(cancelHandler, /editSelectionMessageStrict/);
  assert.doesNotMatch(cancelHandler, /rejectIfActive|replyHtml/);

  const menuHandler = runtimeFunction("handleMenuClose");
  assert.match(menuHandler, /menuClosed/);
  assert.match(menuHandler, /emptyInlineKeyboard/);
  assert.match(menuHandler, /editSelectionMessageStrict/);
  assert.doesNotMatch(menuHandler, /rejectIfActive|replyHtml/);

  const mainKeyboard = runtimeFunction("mainPanelKeyboard");
  assert.match(mainKeyboard, /ui:close:menu/);
  assert.match(mainKeyboard, /t\("close"\)/);
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

  const modelHandler = runtimeFunction("handleSettingsModelSelection");
  assert.match(modelHandler, /editOrReplyHtml/);
  assert.match(modelHandler, /callbackPrefix: "rm:"/);
  assert.match(modelHandler, /settingsSelectionKeyboard/);
  assert.doesNotMatch(modelHandler, /replyHtml/);

  const reasoningHandler = runtimeFunction("handleSettingsReasoningSelection");
  assert.match(reasoningHandler, /continueToFast/);
  assert.match(reasoningHandler, /fastSupported/);
  assert.match(reasoningHandler, /fastKeyboard/);
  assert.match(reasoningHandler, /settingsSelectionKeyboard/);
  assert.match(reasoningHandler, /editOrReplyHtml/);
  assert.doesNotMatch(reasoningHandler, /replyHtml/);

  const navigation = runtimeFunction("settingsSelectionKeyboard");
  assert.match(navigation, /p:settings/);
  assert.match(navigation, /p:main/);
  assert.match(navigation, /withPreviousPanelButton/);
});
