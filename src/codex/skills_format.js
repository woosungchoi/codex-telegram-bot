import { b, code, escapeHtml } from "../telegram/html.js";
import { sanitizeDisplayText, STATUS_ORDER } from "./skills_shared.js";
import { buildSkillDisplayModel, entriesForView, findSkillMatches, normalizeSkillsView, pageEntries, skillViewLabel } from "./skills_view.js";

const DEFAULT_PAGE_SIZE = 40;

export function formatCodexSkillInventory(inventory, { maxChars = Infinity, maxRows = Infinity, pageSize, page = 0, view = "a", query = "" } = {}) {
  const model = buildSkillDisplayModel(inventory || {});
  if (query)
    return fitText(renderSkillQuery(model, query, maxChars), maxChars);
  if (normalizeSkillsView(view) === "w")
    return fitPaged(model, { maxChars, maxRows, pageSize, page, view: "w", render: renderWarnings });
  return fitPaged(model, { maxChars, maxRows, pageSize, page, view, render: renderInventory });
}

export function codexSkillsKeyboard(inventory, { view = "a", page = 0, pageSize = DEFAULT_PAGE_SIZE } = {}) {
  const model = buildSkillDisplayModel(inventory || {});
  const normalizedView = normalizeSkillsView(view);
  const selected = normalizedView === "w" ? model.warnings : entriesForView(model.entries, normalizedView);
  const { page: safePage, pageCount } = pageEntries(selected, page, pageSize);
  const rows = [
    [
      { text: "All", callback_data: "sk:a:0" },
      { text: "Local", callback_data: "sk:l:0" },
      { text: "Enabled", callback_data: "sk:e:0" }
    ],
    [
      { text: "Cached", callback_data: "sk:c:0" },
      { text: "Disabled", callback_data: "sk:d:0" },
      { text: "Warnings", callback_data: "sk:w:0" }
    ]
  ];

  if (pageCount > 1) {
    const previous = Math.max(0, safePage - 1), next = Math.min(pageCount - 1, safePage + 1);
    rows.push([
      { text: "Prev", callback_data: `sk:${normalizedView}:${previous}` },
      { text: `${safePage + 1}/${pageCount}`, callback_data: `sk:${normalizedView}:${safePage}` },
      { text: "Next", callback_data: `sk:${normalizedView}:${next}` }
    ]);
  }
  return { reply_markup: { inline_keyboard: rows } };
}

function fitPaged(model, { maxChars, maxRows, pageSize, page, view, render }) {
  const selected = normalizeSkillsView(view) === "w" ? model.warnings : entriesForView(model.entries, view);
  const firstPageSize = Number.isFinite(maxRows) ? Math.min(maxRows, selected.length) : selected.length;
  const preferredPageSize = Number.isFinite(pageSize) ? pageSize : firstPageSize;
  for (let visibleRows = Math.max(0, preferredPageSize); visibleRows >= 0; visibleRows -= 1) {
    const pageInfo = pageEntries(selected, page, visibleRows);
    const html = render(model, pageInfo, view);
    if (html.length <= maxChars)
      return html;
  }
  return fitText(render(model, pageEntries(selected, page, 0), view), maxChars);
}

function renderInventory(model, pageInfo, view) {
  const lines = [
    b("Codex skills"),
    `Summary: unique ${escapeHtml(model.uniqueCount)} / scanned ${escapeHtml(model.scannedCount)}; duplicates ${escapeHtml(model.duplicateCount)}`,
    `Status: ${STATUS_ORDER.map((status) => `${escapeHtml(status)} ${model.counts[status] || 0}`).join("; ")}`,
    "Status is observable install/cache/config state, not per-session trigger state.",
    `Warnings: ${escapeHtml(model.warnings.length)} sanitized`,
    `View: ${escapeHtml(skillViewLabel(view))}; Page ${escapeHtml(pageInfo.page + 1)}/${escapeHtml(pageInfo.pageCount)}; Showing ${escapeHtml(pageInfo.shown)}/${escapeHtml(pageInfo.total)}`
  ];

  for (const status of STATUS_ORDER) {
    const group = pageInfo.items.filter((skill) => skill.status === status);
    if (group.length === 0)
      continue;
    lines.push("", b(status));
    for (const skill of group)
      lines.push(renderSkillRow(skill));
  }

  const omitted = pageInfo.total - pageInfo.end;
  if (omitted > 0)
    lines.push("", `${escapeHtml(String(omitted))} more omitted.`);
  return lines.join("\n");
}

function renderSkillRow(skill) {
  return `- ${escapeHtml(sanitizeDisplayText(skill.displayName))}${skill.pluginKey ? ` ${code(sanitizeDisplayText(skill.pluginKey))}` : ""}`;
}

function renderSkillQuery(model, query, maxChars) {
  const matches = findSkillMatches(model.entries, query);
  if (matches.length === 0)
    return [b("Codex skill matches"), `Query: ${code(sanitizeDisplayText(query))}`, "No matching skills."].join("\n");
  if (matches.length > 1 && matches[0].displayName.toLowerCase() !== String(query).trim().toLowerCase())
    return renderMatches(query, matches.slice(0, 12));
  return renderSkillDetail(matches[0], maxChars);
}

function renderMatches(query, matches) {
  return [
    b("Codex skill matches"),
    `Query: ${code(sanitizeDisplayText(query))}`,
    "",
    ...matches.map(renderSkillRow)
  ].join("\n");
}

function renderSkillDetail(skill, maxChars) {
  const baseLines = [
    b("Codex skill detail"),
    `Name: ${code(sanitizeDisplayText(skill.displayName))}`,
    `Status: ${code(skill.status)}`,
    ...(skill.pluginKey ? [`Plugin: ${code(sanitizeDisplayText(skill.pluginKey))}`] : []),
    `Sources: ${escapeHtml(String(skill.sources.length))}`
  ];
  const base = baseLines.join("\n");
  const description = sanitizeDisplayText(skill.description || "No description.");
  const budget = Number.isFinite(maxChars) ? Math.max(0, maxChars - base.length - 32) : Infinity;
  return `${base}\nDescription:\n${escapeHtml(truncateText(description, budget))}`;
}

function renderWarnings(model, pageInfo) {
  const lines = [
    b("Codex skill warnings"),
    `Warnings: ${escapeHtml(model.warnings.length)} sanitized`,
    `Page ${escapeHtml(pageInfo.page + 1)}/${escapeHtml(pageInfo.pageCount)}; Showing ${escapeHtml(pageInfo.shown)}/${escapeHtml(pageInfo.total)}`
  ];

  if (pageInfo.items.length === 0)
    lines.push("", "No warnings.");
  else
    lines.push("", ...pageInfo.items.map((warning) => `- ${escapeHtml(sanitizeDisplayText(warning.message))}: ${code(sanitizeDisplayText(warning.target))}`));
  return lines.join("\n");
}

function fitText(value, maxChars) {
  if (!Number.isFinite(maxChars) || value.length <= maxChars)
    return value;
  return truncateText(value, maxChars);
}

function truncateText(value, maxChars) {
  if (!Number.isFinite(maxChars) || value.length <= maxChars)
    return value;
  if (maxChars <= 3)
    return ".".repeat(Math.max(0, maxChars));
  return `${value.slice(0, Math.max(0, maxChars - 3))}...`;
}
