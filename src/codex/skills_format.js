import { b, code, escapeHtml } from "../telegram/html.js";
import { countByStatus, sanitizeDisplayText, STATUS_ORDER } from "./skills_shared.js";

export function formatCodexSkillInventory(inventory, { maxChars = Infinity, maxRows = 40 } = {}) {
  const safeInventory = inventory || { skills: [], warnings: [] }, rowLimit = Math.max(0, Math.min(maxRows, safeInventory.skills.length));
  for (let visibleRows = rowLimit; visibleRows >= 0; visibleRows -= 1) {
    const html = renderInventory(safeInventory, visibleRows);
    if (html.length <= maxChars)
      return html;
  }
  return renderInventory(safeInventory, 0);
}

function renderInventory(inventory, visibleRows) {
  const skills = inventory.skills || [], counts = inventory.counts || countByStatus(skills), visibleSkills = skills.slice(0, visibleRows);
  const lines = [
    b("Codex skills"),
    `Summary: ${STATUS_ORDER.map((status) => `${escapeHtml(status)} ${counts[status] || 0}`).join("; ")}`,
    "Status is observable install/cache/config state, not per-session trigger state.",
    `Warnings: ${escapeHtml(String((inventory.warnings || []).length))} sanitized`
  ];

  for (const status of STATUS_ORDER) {
    const group = visibleSkills.filter((skill) => skill.status === status);
    if (group.length === 0)
      continue;
    lines.push("", b(status));
    for (const skill of group)
      lines.push(renderSkillRow(skill));
  }

  const omitted = skills.length - visibleSkills.length;
  if (omitted > 0)
    lines.push("", `${escapeHtml(String(omitted))} more omitted.`);
  return lines.join("\n");
}

function renderSkillRow(skill) {
  return `- ${escapeHtml(sanitizeDisplayText(skill.displayName))}${skill.pluginKey ? ` ${code(sanitizeDisplayText(skill.pluginKey))}` : ""}${skill.description ? ` - ${escapeHtml(sanitizeDisplayText(skill.description))}` : ""}`;
}
