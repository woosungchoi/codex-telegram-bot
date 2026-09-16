import { commandParent, legacyMenuRows, previousPanelFor, renderMenu } from "./menu_definition.js";

export function chunkButtons(buttons, size) {
  const rows = [];
  for (let index = 0; index < buttons.length; index += size) {
    rows.push(buttons.slice(index, index + size));
  }
  return rows;
}

export function inlineKeyboard(rows) {
  return { reply_markup: { inline_keyboard: rows } };
}

export function commandReplyKeyboard(ctx, text, keyboard) {
  if (!ctx.callbackQuery) return keyboard;
  const navigation = createNavigationKeyboardViews({ text });
  const back = legacyMenuRows(keyboard?.reply_markup?.inline_keyboard).flat().find((button) => button.role === "back");
  return navigation.withMenuCloseButton(navigation.withPreviousPanelButton(keyboard, back ? null : commandParent(ctx)));
}

export function createNavigationKeyboardViews({ text }) {
  const t = text;

  function emptyInlineKeyboard() {
    return inlineKeyboard([]);
  }

  function withPreviousPanelButton(keyboard, previousPanel) {
    if (!previousPanel) return keyboard;
    return withPreviousButton(keyboard, `p:${previousPanel}`);
  }

  function withPreviousButton(keyboard, callbackData) {
    return renderMenu(keyboard, { text: t, previous: callbackData });
  }

  function withMenuCloseButton(keyboard) {
    return renderMenu(keyboard, { text: t, close: true });
  }

  function backToMainKeyboard() {
    return withMenuCloseButton(withPreviousPanelButton(inlineKeyboard([[{ text: t("main"), callback_data: "p:main" }]]), "main"));
  }

  return {
    backToMainKeyboard,
    emptyInlineKeyboard,
    previousPanelFor,
    withMenuCloseButton,
    withPreviousButton,
    withPreviousPanelButton
  };
}
