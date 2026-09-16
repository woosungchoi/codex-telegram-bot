import { textFor } from "../i18n.js";
import { collectCodexSkillInventory } from "./skills_inventory.js";
import { codexSkillsKeyboard, formatCodexSkillInventory } from "./skills_format.js";

export { collectCodexSkillInventory } from "./skills_inventory.js";
export { codexSkillsKeyboard, formatCodexSkillInventory } from "./skills_format.js";
export { isCodexSkillsView } from "./skills_view.js";

export async function replyCodexSkillsStatus(ctx, deps, options = {}) {
  const requestedMaxChars = deps.runtimeValue("maxTelegramChars");
  const maxChars = Number.isFinite(requestedMaxChars) && requestedMaxChars > 0 ? requestedMaxChars : Infinity;
  const text = deps.text || ((key) => textFor(deps.config?.telegramLanguage || "en", key));
  let html, inventory;
  try {
    inventory = await collectCodexSkillInventory({ codexHome: deps.config?.codexHome });
    html = formatCodexSkillInventory(inventory, { text, maxChars, view: options.view, page: options.page, query: options.query });
  } catch {
    inventory = { skills: [], warnings: [{ message: text("skills.unavailable"), target: "CODEX_HOME" }] };
    html = formatCodexSkillInventory(inventory, { text, maxChars, view: options.view, page: options.page, query: options.query });
  }
  return (options.edit ? deps.editOrReplyHtml : deps.replyHtml)(ctx, html, mergeExtra(codexSkillsKeyboard(inventory, { ...options, text }), options.extra));
}

function mergeExtra(baseExtra, extra) {
  const baseRows = baseExtra?.reply_markup?.inline_keyboard || [];
  const extraRows = extra?.reply_markup?.inline_keyboard || [];
  return {
    ...(extra || {}),
    reply_markup: {
      ...(extra?.reply_markup || {}),
      inline_keyboard: [...baseRows, ...extraRows]
    }
  };
}
