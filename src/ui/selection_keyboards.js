import { textFor } from "../i18n.js";
import { chunkButtons, inlineKeyboard } from "./keyboard_helpers.js";

export function booleanOptionKeyboardRows(key, settingsLabel, text = (key) => textFor("en", key)) {
  return [
    [
      { text: text("default"), callback_data: `set:${key}:default` },
      { text: text("on"), callback_data: `set:${key}:on` },
      { text: text("off"), callback_data: `set:${key}:off` }
    ],
    [{ text: settingsLabel, callback_data: "p:settings" }]
  ];
}

export function modelSelectionKeyboard(models, { callbackPrefix = "model:set:", text = (key) => textFor("en", key) } = {}) {
  const buttons = models.map((model) => ({
    text: `${model.displayName}${model.fastSupported ? " ⚡" : ""}`,
    callback_data: `${callbackPrefix}${model.slug}`
  }));
  return inlineKeyboard([
    ...chunkButtons(buttons, 2),
    [{ text: text("default"), callback_data: `${callbackPrefix}default` }]
  ]);
}

export function reasoningSelectionKeyboard(reasoningOptions, { callbackPrefix = "reasoning:set:", text = (key) => textFor("en", key) } = {}) {
  const buttons = [
    { text: text("default"), callback_data: `${callbackPrefix}default` },
    ...reasoningOptions.map(({ effort }) => ({
      text: effort,
      callback_data: `${callbackPrefix}${effort}`
    }))
  ];
  return inlineKeyboard(chunkButtons(buttons, 3));
}

export function createSelectionKeyboardViews({
  text,
  withMenuCloseButton,
  withPreviousPanelButton
}) {
  const t = text;

  function fastKeyboard() {
    return inlineKeyboard([
      [
        { text: t("on"), callback_data: "set:fast:on" },
        { text: t("off"), callback_data: "set:fast:off" }
      ],
      [
        { text: t("settings"), callback_data: "p:settings" },
        { text: t("main"), callback_data: "p:main" }
      ]
    ]);
  }

  function standaloneModelSelectionKeyboard(models, session) {
    return withSelectionCancel(
      modelSelectionKeyboard(models, { callbackPrefix: `m:${session.token}:`, text }),
      session
    );
  }

  function standaloneReasoningSelectionKeyboard(reasoningOptions, session) {
    return withSelectionCancel(
      reasoningSelectionKeyboard(reasoningOptions, { callbackPrefix: `r:${session.token}:`, text }),
      session
    );
  }

  function standaloneFastSelectionKeyboard(session) {
    return withSelectionCancel(inlineKeyboard([[
      { text: t("on"), callback_data: `f:${session.token}:on` },
      { text: t("off"), callback_data: `f:${session.token}:off` }
    ]]), session);
  }

  function withSelectionCancel(keyboard, session) {
    const rows = keyboard?.reply_markup?.inline_keyboard
      ? keyboard.reply_markup.inline_keyboard.map((row) => [...row])
      : [];
    rows.push([{ text: t("cancel"), callback_data: `x:${session.token}` }]);
    return inlineKeyboard(rows);
  }

  function settingsSelectionKeyboard(keyboard, previousPanel) {
    const rows = keyboard?.reply_markup?.inline_keyboard
      ? keyboard.reply_markup.inline_keyboard.map((row) => [...row])
      : [];
    const navigation = [];
    if (!rows.some((row) => row.some(({ callback_data: callbackData }) => callbackData === "p:settings"))) {
      navigation.push({ text: t("settings"), callback_data: "p:settings" });
    }
    if (!rows.some((row) => row.some(({ callback_data: callbackData }) => callbackData === "p:main"))) {
      navigation.push({ text: t("main"), callback_data: "p:main" });
    }
    if (navigation.length > 0) rows.push(navigation);
    return withMenuCloseButton(withPreviousPanelButton(inlineKeyboard(rows), previousPanel));
  }

  return {
    fastKeyboard,
    settingsSelectionKeyboard,
    standaloneFastSelectionKeyboard,
    standaloneModelSelectionKeyboard,
    standaloneReasoningSelectionKeyboard,
    withSelectionCancel
  };
}
