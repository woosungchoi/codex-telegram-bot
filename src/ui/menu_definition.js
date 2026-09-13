import { menuButtonText } from "./button_labels.js";

// Stable ids are also callback protocol ids. Add panel metadata here once.
const panels = {
  main: [null, "🏠", "main"],
  status: ["main", "📋", "status"],
  queue: ["main", "📥", "queue"],
  settings: ["main", "⚙️", "settings"],
  tools: ["main", "🛠️", "tools"],
  help: ["main", "❓", "help"],
  settings_runtime: ["settings", "⚙️", "runtimeTitle"],
  settings_timezone: ["settings", "🕒", "timeZoneTitle"],
};
for (const id of [
  "model",
  "reasoning",
  "fast",
  "sandbox",
  "approval",
  "web",
  "network",
  "stream",
  "live_progress",
  "git",
  "paths",
  "schema",
  "language",
  "locale",
]) {
  panels[`settings_${id}`] = ["settings", undefined, undefined];
}
for (const id of ["output", "queue", "codex", "cleanup", "snapshot"])
  panels[`settings_runtime_${id}`] = ["settings_runtime", "⚙️", undefined];

export const MENU_DEFINITIONS = Object.freeze(
  Object.fromEntries(
    Object.entries(panels).map(([id, [parent, icon, labelKey]]) => [
      id,
      Object.freeze({ id, parent, icon, labelKey }),
    ]),
  ),
);
export const WORKSPACE_INPUT_PARENTS = Object.freeze({
  project: "projects",
  session: "sessions",
  task: "tasks",
  forum: "forum",
});

export function previousPanelFor(panel) {
  if (MENU_DEFINITIONS[panel]) return MENU_DEFINITIONS[panel].parent;
  if (panel.startsWith("settings_timezone_")) return "settings_timezone";
  if (panel.startsWith("settings_runtime_")) return "settings_runtime";
  return panel.startsWith("settings_") ? "settings" : "main";
}

// This is the sole adapter for older keyboard factories and persisted markup.
// New definitions use explicit roles; display wording is not their identity.
export function legacyMenuRows(rows = []) {
  return rows.map((row) =>
    row.map((button) => ({
      ...button,
      role:
        button.role ||
        (button.callback_data === "ui:close:menu"
          ? "close"
          : /^(?:←|⬅)\s*/u.test(button.text || "")
            ? "back"
            : "action"),
    })),
  );
}

export function completeMenuRows(rows, { back, close } = {}) {
  const result = rows
    .map((row) => row.filter((button) => button.role !== "close"))
    .filter((row) => row.length);
  if (
    back &&
    !result.some((row) => row.some((button) => button.role === "back"))
  )
    result.push([back]);
  if (close) result.push([close]);
  return result;
}

export function renderMenuButton(button, text = (key) => key) {
  const { role: _role, icon, labelKey, ...wire } = button;
  const definition = wire.callback_data?.startsWith("p:")
    ? MENU_DEFINITIONS[wire.callback_data.slice(2)]
    : null;
  const label = labelKey
    ? text(labelKey)
    : (wire.text ?? text(definition?.labelKey || definition?.id || ""));
  const prefix = /^[\p{Extended_Pictographic}\p{Regional_Indicator}]/u.test(
    label,
  )
    ? ""
    : icon || definition?.icon;
  return {
    ...wire,
    text: menuButtonText(
      prefix ? `${prefix} ${label}` : label,
      wire.callback_data || (wire.url ? "web" : ""),
    ),
  };
}

export function renderMenu(keyboard, { text, previous, close } = {}) {
  let rows = legacyMenuRows(keyboard?.reply_markup?.inline_keyboard);
  const currentBack = rows.flat().find((button) => button.role === "back");
  const currentClose = rows.flat().find((button) => button.role === "close");
  const destination =
    previous === undefined ? currentBack?.callback_data : previous;
  rows = rows.map((row) => row.filter((button) => button.role !== "back"));
  const back = destination
    ? {
        role: "back",
        text: `⬅️ ${text("back").replace(/^(?:←|⬅️)\s*/u, "")}`,
        callback_data: destination,
      }
    : null;
  const closing =
    close === undefined
      ? currentClose
      : close
        ? { role: "close", text: text("close"), callback_data: "ui:close:menu" }
        : null;
  rows = completeMenuRows(rows, { back, close: closing });
  return {
    ...keyboard,
    reply_markup: {
      ...keyboard?.reply_markup,
      inline_keyboard: rows.map((row) =>
        row.map((button) => renderMenuButton(button, text)),
      ),
    },
  };
}

export function commandParent(ctx) {
  return ctx.callbackQuery?.data === "act:restart"
    ? "settings_runtime_codex"
    : ctx.callbackQuery?.data?.startsWith("tool:")
      ? "tools"
      : "main";
}
