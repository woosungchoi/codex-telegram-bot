import { countByStatus, STATUS_ORDER } from "./skills_shared.js";

export const SKILL_VIEW_IDS = new Set(["a", "l", "e", "c", "d", "w"]);

export function isCodexSkillsView(value) {
  return SKILL_VIEW_IDS.has(value);
}

export function normalizeSkillsView(value) {
  return isCodexSkillsView(value) ? value : "a";
}

export function buildSkillDisplayModel(inventory = {}) {
  const skills = Array.isArray(inventory.skills) ? inventory.skills : [];
  const warnings = Array.isArray(inventory.warnings) ? inventory.warnings : [];
  const byKey = new Map();

  for (const skill of skills) {
    const entry = displayEntry(byKey, skill);
    entry.sources.push(skill.relativePath || "");
    if (!entry.description && skill.description)
      entry.description = skill.description;
  }

  const entries = [...byKey.values()].sort(compareEntries);
  return {
    entries,
    warnings,
    scannedCount: skills.length,
    uniqueCount: entries.length,
    duplicateCount: Math.max(0, skills.length - entries.length),
    counts: countByStatus(entries),
    rawCounts: inventory.counts || countByStatus(skills)
  };
}

export function entriesForView(entries, view) {
  const normalizedView = normalizeSkillsView(view);
  if (normalizedView === "l")
    return entries.filter((entry) => entry.status === "local/system" || entry.status === "local/custom");
  if (normalizedView === "e")
    return entries.filter((entry) => entry.status === "plugin enabled");
  if (normalizedView === "c")
    return entries.filter((entry) => entry.status === "plugin cached");
  if (normalizedView === "d")
    return entries.filter((entry) => entry.status === "plugin disabled");
  return entries;
}

export function pageEntries(entries, page, pageSize) {
  const safeSize = Math.max(0, Number.isFinite(pageSize) ? Math.floor(pageSize) : entries.length);
  const pageCount = safeSize > 0 ? Math.max(1, Math.ceil(entries.length / safeSize)) : 1;
  const safePage = Math.min(Math.max(0, Number.isFinite(page) ? Math.floor(page) : 0), pageCount - 1);
  const start = safeSize * safePage;
  return {
    items: safeSize > 0 ? entries.slice(start, start + safeSize) : [],
    page: safePage,
    pageCount,
    end: safeSize > 0 ? Math.min(entries.length, start + safeSize) : 0,
    shown: safeSize > 0 ? Math.min(entries.length, start + safeSize) - start : 0,
    total: entries.length
  };
}

export function findSkillMatches(entries, query) {
  const needle = normalizeSearch(query);
  if (!needle)
    return [];
  return entries
    .map((entry) => ({ entry, score: matchScore(entry, needle) }))
    .filter((match) => match.score > 0)
    .sort((left, right) => right.score - left.score || compareEntries(left.entry, right.entry))
    .map((match) => match.entry);
}

export function skillViewLabel(view) {
  return {
    a: "all",
    l: "local",
    e: "enabled",
    c: "cached",
    d: "disabled",
    w: "warnings"
  }[normalizeSkillsView(view)];
}

function displayEntry(byKey, skill) {
  const status = skill.status || "plugin cached";
  const pluginKey = skill.pluginKey || "";
  const displayName = skill.displayName || "unnamed";
  const key = [status, pluginKey, displayName].join("\0");
  if (!byKey.has(key))
    byKey.set(key, { status, pluginKey, displayName, description: skill.description || "", sources: [] });
  return byKey.get(key);
}

function compareEntries(left, right) {
  const statusDelta = STATUS_ORDER.indexOf(left.status) - STATUS_ORDER.indexOf(right.status);
  if (statusDelta !== 0)
    return statusDelta;
  const nameDelta = left.displayName.localeCompare(right.displayName, "en", { sensitivity: "base" });
  if (nameDelta !== 0)
    return nameDelta;
  return left.pluginKey.localeCompare(right.pluginKey, "en", { sensitivity: "base" });
}

function matchScore(entry, needle) {
  const name = normalizeSearch(entry.displayName);
  const plugin = normalizeSearch(entry.pluginKey);
  if (name === needle || `${plugin}:${name}` === needle)
    return 100;
  if (name.startsWith(needle))
    return 80;
  if (plugin && plugin.includes(needle))
    return 60;
  if (name.includes(needle))
    return 40;
  return 0;
}

function normalizeSearch(value) {
  return String(value || "").trim().toLowerCase();
}
