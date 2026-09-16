// Decorate display labels only; callback data, URLs and Telegram button options
// must stay untouched. Keep this at the menu boundary, not in model identifiers.
const icons = [
  [/close|hide/, "✖️"], [/cancel|ignore/, "↩️"], [/^(?:p:main|home)$/, "🏠"], [/prefs_reset/, "🔄"],
  [/usage|report|dashboard/, "📊"], [/acct:reset/, "🎟️"], [/account|acct:/, "👥"],
  [/model|^m:/, "🤖"], [/reasoning|thinking|^r:/, "🧠"], [/fast|^f:/, "⚡"],
  [/sandbox|approval|permission/, "🛡️"], [/web|network/, "🌐"],
  [/timezone|time_zone|schedule/, "🕒"], [/language|locale/, "🌐"],
  [/stream|progress|output|answer/, "💬"], [/path|workdir|project/, "📁"],
  [/schema/, "📐"], [/git/, "🌿"], [/snapshot|backup/, "💾"],
  [/export/, "📤"], [/cleanup|forget|delete|remove|clear/, "🧹"],
  [/health|doctor|test|worker_status|appserver_status/, "🩺"],
  [/logs/, "📜"], [/whoami/, "🪪"], [/skills/, "🧠"], [/mcp/, "🧩"],
  [/maintenance|tools/, "🛠️"], [/settings|runtime|config/, "⚙️"],
  [/pause/, "⏸️"], [/resume|run|start/, "▶️"], [/stop/, "🛑"],
  [/queue/, "📥"], [/status/, "📋"], [/refresh|reload/, "🔄"],
  [/session/, "🗂️"], [/task/, "⏰"], [/forum-send/, "📨"], [/forum/, "🏷️"], [/help/, "❓"],
  [/confirm|save/, "✅"], [/default/, "🔧"], [/new|add/, "➕"]
];

export function menuButtonText(label, action = "") {
  const text = String(label);
  if (/^←\s*/u.test(text)) return text.replace(/^←\s*/u, "⬅️ ");
  if (/^[\p{Extended_Pictographic}\p{Regional_Indicator}]/u.test(text)) return text;
  return `${icons.find(([pattern]) => pattern.test(action))?.[1] || "🔹"} ${text}`;
}

export function decorateMenuKeyboard(keyboard) {
  const rows = keyboard?.reply_markup?.inline_keyboard;
  if (!rows) return keyboard;
  return {
    ...keyboard,
    reply_markup: {
      ...keyboard.reply_markup,
      inline_keyboard: rows.map((row) => row.map((button) => ({
        ...button, text: menuButtonText(button.text, button.callback_data || (button.url ? "web" : ""))
      })))
    }
  };
}
