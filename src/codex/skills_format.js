import { createMessageFormatter } from "../i18n.js";
import { b, code, escapeHtml } from "../telegram/html.js";
import { sanitizeDisplayText, STATUS_ORDER } from "./skills_shared.js";
import { buildSkillDisplayModel, entriesForView, findSkillMatches, normalizeSkillsView, pageEntries, skillViewLabel } from "./skills_view.js";

const DEFAULT_PAGE_SIZE = 40;

export function formatCodexSkillInventory(inventory, { maxChars = Infinity, maxRows = Infinity, pageSize, page = 0, view = "a", query = "", text } = {}) {
  const msg = createMessageFormatter(text);
  const model = buildSkillDisplayModel(inventory || {});
  if (query)
    return fitText(renderSkillQuery(model, query, maxChars, msg), maxChars);
  if (normalizeSkillsView(view) === "w")
    return fitPaged(model, { maxChars, maxRows, pageSize, page, view: "w", render: renderWarnings, msg });
  return fitPaged(model, { maxChars, maxRows, pageSize, page, view, render: renderInventory, msg });
}

export function codexSkillsKeyboard(inventory, { view = "a", page = 0, pageSize = DEFAULT_PAGE_SIZE, text } = {}) {
  const msg = createMessageFormatter(text);
  const model = buildSkillDisplayModel(inventory || {});
  const normalizedView = normalizeSkillsView(view);
  const selected = normalizedView === "w" ? model.warnings : entriesForView(model.entries, normalizedView);
  const { page: safePage, pageCount } = pageEntries(selected, page, pageSize);
  const rows = [
    [
      { text: msg("skills.all"), callback_data: "sk:a:0" },
      { text: msg("skills.local"), callback_data: "sk:l:0" },
      { text: msg("skills.enabled"), callback_data: "sk:e:0" }
    ],
    [
      { text: msg("skills.cached"), callback_data: "sk:c:0" },
      { text: msg("skills.disabled"), callback_data: "sk:d:0" },
      { text: msg("skills.warnings"), callback_data: "sk:w:0" }
    ]
  ];

  if (pageCount > 1) {
    const previous = Math.max(0, safePage - 1), next = Math.min(pageCount - 1, safePage + 1);
    rows.push([
      { text: msg("skills.previous"), callback_data: `sk:${normalizedView}:${previous}` },
      { text: `${safePage + 1}/${pageCount}`, callback_data: `sk:${normalizedView}:${safePage}` },
      { text: msg("skills.next"), callback_data: `sk:${normalizedView}:${next}` }
    ]);
  }
  return { reply_markup: { inline_keyboard: rows } };
}

function fitPaged(model, { maxChars, maxRows, pageSize, page, view, render, msg }) {
  const selected = normalizeSkillsView(view) === "w" ? model.warnings : entriesForView(model.entries, view);
  const firstPageSize = Number.isFinite(maxRows) ? Math.min(maxRows, selected.length) : selected.length;
  const preferredPageSize = Number.isFinite(pageSize) ? pageSize : firstPageSize;
  for (let visibleRows = Math.max(0, preferredPageSize); visibleRows >= 0; visibleRows -= 1) {
    const pageInfo = pageEntries(selected, page, visibleRows);
    const html = render(model, pageInfo, view, msg);
    if (html.length <= maxChars)
      return html;
  }
  return fitText(render(model, pageEntries(selected, page, 0), view, msg), maxChars);
}

function renderInventory(model, pageInfo, view, msg) {
  const lines = [
    b(msg("skills.title")),
    msg("skills.summary", { unique: escapeHtml(model.uniqueCount), scanned: escapeHtml(model.scannedCount), duplicates: escapeHtml(model.duplicateCount) }),
    msg("skills.statusLine", { status: STATUS_ORDER.map((status) => `${escapeHtml(msg(`skills.status.${status}`))} ${model.counts[status] || 0}`).join("; ") }),
    msg("skills.statusHelp"),
    msg("skills.warningCount", { count: escapeHtml(model.warnings.length) }),
    msg("skills.page", { view: escapeHtml(msg(`skills.view.${skillViewLabel(view)}`)), page: escapeHtml(pageInfo.page + 1), pages: escapeHtml(pageInfo.pageCount), shown: escapeHtml(pageInfo.shown), total: escapeHtml(pageInfo.total) })
  ];

  for (const status of STATUS_ORDER) {
    const group = pageInfo.items.filter((skill) => skill.status === status);
    if (group.length === 0)
      continue;
    lines.push("", b(msg(`skills.status.${status}`)));
    for (const skill of group)
      lines.push(renderSkillRow(skill));
  }

  const omitted = pageInfo.total - pageInfo.end;
  if (omitted > 0)
    lines.push("", msg("skills.omitted", { count: escapeHtml(String(omitted)) }));
  return lines.join("\n");
}

function renderSkillRow(skill) {
  return `- ${escapeHtml(sanitizeDisplayText(skill.displayName))}${skill.pluginKey ? ` ${code(sanitizeDisplayText(skill.pluginKey))}` : ""}`;
}

function renderSkillQuery(model, query, maxChars, msg) {
  const matches = findSkillMatches(model.entries, query);
  if (matches.length === 0)
    return [b(msg("skills.matches")), msg("skills.query", { value: code(sanitizeDisplayText(query)) }), msg("skills.noMatches")].join("\n");
  if (matches.length > 1 && matches[0].displayName.toLowerCase() !== String(query).trim().toLowerCase())
    return renderMatches(query, matches.slice(0, 12), msg);
  return renderSkillDetail(matches[0], maxChars, msg);
}

function renderMatches(query, matches, msg) {
  return [
    b(msg("skills.matches")),
    msg("skills.query", { value: code(sanitizeDisplayText(query)) }),
    "",
    ...matches.map(renderSkillRow)
  ].join("\n");
}

function renderSkillDetail(skill, maxChars, msg) {
  const baseLines = [
    b(msg("skills.detail")),
    msg("skills.name", { value: code(sanitizeDisplayText(skill.displayName)) }),
    msg("skills.statusLine", { status: code(msg(`skills.status.${skill.status}`)) }),
    ...(skill.pluginKey ? [msg("skills.plugin", { value: code(sanitizeDisplayText(skill.pluginKey)) })] : []),
    msg("skills.sources", { count: escapeHtml(String(skill.sources.length)) })
  ];
  const base = baseLines.join("\n");
  const description = sanitizeDisplayText(skill.description || msg("skills.noDescription"));
  const budget = Number.isFinite(maxChars) ? Math.max(0, maxChars - base.length - 32) : Infinity;
  return msg("skills.description", { header: base, description: escapeHtml(truncateText(description, budget)) });
}

function renderWarnings(model, pageInfo, _view, msg) {
  const lines = [
    b(msg("skills.warningsTitle")),
    msg("skills.warningCount", { count: escapeHtml(model.warnings.length) }),
    msg("skills.warningPage", { page: escapeHtml(pageInfo.page + 1), pages: escapeHtml(pageInfo.pageCount), shown: escapeHtml(pageInfo.shown), total: escapeHtml(pageInfo.total) })
  ];

  if (pageInfo.items.length === 0)
    lines.push("", msg("skills.noWarnings"));
  else
    lines.push("", ...pageInfo.items.map((warning) => `- ${escapeHtml(sanitizeDisplayText(warning.messageKey ? msg(warning.messageKey) : warning.message))}: ${code(sanitizeDisplayText(warning.target))}`));
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
