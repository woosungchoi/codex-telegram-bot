import test from "node:test";
import assert from "node:assert/strict";
import { createRuntimeKeyboardViews } from "../src/ui/keyboards.js";

const keyboardViews = createRuntimeKeyboardViews({
  text: (key) => key === "close" ? "Close" : key,
  hasActiveTurn: () => false,
  sideTurnCount: () => 0,
  currentLanguage: () => "en",
  currentTimeZone: () => "UTC",
  currentLocale: () => "en-US",
  isQueuePaused: () => false,
  pendingTurnsFor: () => [{ id: "turn-1" }],
  maintenanceAutoHandoffEnabled: () => true,
  maintenanceAutoSqliteRepairEnabled: () => false
});

function buttons(keyboard) {
  return keyboard.reply_markup.inline_keyboard.flat();
}

function closeButtons(keyboard) {
  return buttons(keyboard).filter(
    ({ callback_data: callbackData }) => callbackData === "ui:close:menu"
  );
}

test("standalone model and reasoning keyboards stay isolated and cancellable", () => {
  const session = { token: "abc123" };
  const modelButtons = buttons(
    keyboardViews.standaloneModelSelectionKeyboard(
      [{ slug: "model", displayName: "Model" }],
      session
    )
  );
  const reasoningButtons = buttons(
    keyboardViews.standaloneReasoningSelectionKeyboard([{ effort: "high" }], session)
  );
  assert.ok(
    modelButtons.some(({ callback_data: callbackData }) => callbackData === "m:abc123:model")
  );
  assert.ok(
    reasoningButtons.some(
      ({ callback_data: callbackData }) => callbackData === "r:abc123:high"
    )
  );
  for (const rows of [modelButtons, reasoningButtons]) {
    assert.ok(rows.some(({ callback_data: callbackData }) => callbackData === "x:abc123"));
    assert.ok(
      rows.every(
        ({ callback_data: callbackData }) => !["p:settings", "p:main"].includes(callbackData)
      )
    );
  }
});

test("main and stable menu stages expose exactly one close button", () => {
  for (const keyboard of [
    keyboardViews.mainPanelKeyboard("chat"),
    keyboardViews.statusKeyboard("chat"),
    keyboardViews.settingsKeyboard(),
    keyboardViews.settingsSelectionKeyboard(
      keyboardViews.emptyInlineKeyboard(),
      "settings_model"
    ),
    keyboardViews.runtimeKeyboard(),
    keyboardViews.runtimeCodexKeyboard(),
    keyboardViews.backToMainKeyboard(),
    keyboardViews.queueKeyboard("chat"),
    keyboardViews.withToolsBack(),
    keyboardViews.codexMaintenanceKeyboard()
  ]) {
    assert.equal(closeButtons(keyboard).length, 1);
  }
  const mainClose = closeButtons(keyboardViews.mainPanelKeyboard("chat"))[0];
  assert.deepEqual(mainClose, {
    text: "Close",
    callback_data: "ui:close:menu"
  });
});

test("menu close decoration is immutable, idempotent, unique, and last", () => {
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

  const decorated = keyboardViews.withMenuCloseButton(keyboard);
  assert.deepEqual(keyboard, original);
  assert.deepEqual(decorated.reply_markup.inline_keyboard, [
    [{ text: "Main", callback_data: "p:main" }],
    [{ text: "Back", callback_data: "p:settings" }],
    [{ text: "Close", callback_data: "ui:close:menu" }]
  ]);
  assert.deepEqual(keyboardViews.withMenuCloseButton(decorated), decorated);
});

test("queue and maintenance keyboards keep their dynamic runtime state", () => {
  const queueButtons = buttons(keyboardViews.queueKeyboard("chat"));
  assert.ok(
    queueButtons.some(
      ({ callback_data: callbackData }) => callbackData === "queue:cancel:turn-1"
    )
  );
  assert.ok(
    queueButtons.some(({ callback_data: callbackData }) => callbackData === "q:clear")
  );

  const maintenanceButtons = buttons(keyboardViews.codexMaintenanceKeyboard());
  assert.equal(
    maintenanceButtons.find(
      ({ callback_data: callbackData }) =>
        callbackData === "tool:codex_maintenance_auto_handoff"
    ).style,
    "success"
  );
  assert.equal(
    maintenanceButtons.find(
      ({ callback_data: callbackData }) =>
        callbackData === "tool:codex_maintenance_auto_sqlite_repair"
    ).style,
    "primary"
  );
});

test("selection and processing keyboards do not offer menu close", () => {
  const selection = keyboardViews.withSelectionCancel(
    keyboardViews.emptyInlineKeyboard(),
    { token: "abc123" }
  );
  assert.equal(closeButtons(selection).length, 0);
  assert.equal(closeButtons(keyboardViews.codexMaintenanceBusyKeyboard()).length, 0);
  assert.equal(closeButtons(keyboardViews.uploadCleanupKeyboard("plan-1")).length, 0);
});

test("settings model flow includes settings, main, previous, and close navigation", () => {
  const navigation = buttons(
    keyboardViews.settingsSelectionKeyboard(
      keyboardViews.emptyInlineKeyboard(),
      "settings_model"
    )
  );
  assert.ok(
    navigation.some(({ callback_data: callbackData }) => callbackData === "p:settings")
  );
  assert.ok(
    navigation.some(({ callback_data: callbackData }) => callbackData === "p:main")
  );
  assert.ok(
    navigation.some(
      ({ callback_data: callbackData, text }) =>
        callbackData === "p:settings_model" && text.includes("←")
    )
  );
  assert.equal(
    navigation.filter(
      ({ callback_data: callbackData }) => callbackData === "ui:close:menu"
    ).length,
    1
  );
});
