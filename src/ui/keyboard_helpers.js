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

export function createNavigationKeyboardViews({ text }) {
  const t = text;

  function emptyInlineKeyboard() {
    return inlineKeyboard([]);
  }

  function withPreviousPanelButton(keyboard, previousPanel) {
    if (!previousPanel) return keyboard;
    const callbackData = `p:${previousPanel}`;
    const rows = keyboard?.reply_markup?.inline_keyboard ? [...keyboard.reply_markup.inline_keyboard] : [];
    const hasPreviousButton = rows.some((row) => row.some((button) => (
      button?.callback_data === callbackData && String(button.text || "").includes("←")
    )));
    if (!hasPreviousButton) rows.push([{ text: `← ${t("back")}`, callback_data: callbackData }]);
    return inlineKeyboard(rows);
  }

  function withMenuCloseButton(keyboard) {
    const callbackData = "ui:close:menu";
    const rows = keyboard?.reply_markup?.inline_keyboard
      ? keyboard.reply_markup.inline_keyboard
        .map((row) => row.filter((button) => button?.callback_data !== callbackData))
        .filter((row) => row.length > 0)
      : [];
    rows.push([{ text: t("close"), callback_data: callbackData }]);
    return inlineKeyboard(rows);
  }

  function previousPanelFor(panel) {
    if (panel === "main") return null;
    if (["status", "queue", "settings", "tools", "help"].includes(panel)) return "main";
    if (panel.startsWith("settings_timezone_")) return "settings_timezone";
    if (panel.startsWith("settings_runtime_")) return "settings_runtime";
    if (panel.startsWith("settings_")) return "settings";
    return "main";
  }

  function backToMainKeyboard() {
    return withMenuCloseButton(inlineKeyboard([[{ text: t("main"), callback_data: "p:main" }]]));
  }

  return {
    backToMainKeyboard,
    emptyInlineKeyboard,
    previousPanelFor,
    withMenuCloseButton,
    withPreviousPanelButton
  };
}
