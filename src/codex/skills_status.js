import { collectCodexSkillInventory } from "./skills_inventory.js";
import { formatCodexSkillInventory } from "./skills_format.js";

export { collectCodexSkillInventory } from "./skills_inventory.js";
export { formatCodexSkillInventory } from "./skills_format.js";

export async function replyCodexSkillsStatus(ctx, deps, options = {}) {
  const requestedMaxChars = deps.runtimeValue("maxTelegramChars");
  const maxChars = Number.isFinite(requestedMaxChars) && requestedMaxChars > 0 ? requestedMaxChars : Infinity;
  let html;
  try {
    const inventory = await collectCodexSkillInventory({ codexHome: deps.config?.codexHome });
    html = formatCodexSkillInventory(inventory, { maxChars });
  } catch {
    html = formatCodexSkillInventory({ skills: [], warnings: [{ message: "skill inventory unavailable", target: "CODEX_HOME" }] }, { maxChars });
  }
  return (options.edit ? deps.editOrReplyHtml : deps.replyHtml)(ctx, html, options.extra);
}
