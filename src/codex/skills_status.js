import fs from "node:fs/promises";
import path from "node:path";
import { b, code, escapeHtml } from "../telegram/html.js";

const STATUS_ORDER = ["local/system", "local/custom", "plugin enabled", "plugin cached", "plugin disabled"];
const DEFAULT_MAX_ROWS = 40;
const ABSOLUTE_POSIX_PATH_PATTERN = /(^|[\s([{=,]|:(?!\/\/)|file:\/\/)\/[^\s<>"'`]*/g;

export async function collectCodexSkillInventory({ codexHome, pluginCacheDir, configPath } = {}) {
  const root = path.resolve(codexHome || "");
  const warnings = [];
  const skills = [];
  const seen = new Set();
  const context = { codexHome: root, warnings, skills, seen };
  const resolvedPluginCacheDir = pluginCacheDir ? path.resolve(pluginCacheDir) : path.join(root, "plugins", "cache");
  const resolvedConfigPath = configPath ? path.resolve(configPath) : path.join(root, "config.toml");
  const pluginConfig = await readPluginConfig(resolvedConfigPath, warnings, root);

  await collectLocalSkills({ ...context, rootDir: path.join(root, "skills", ".system"), status: "local/system" });
  await collectLocalSkills({ ...context, rootDir: path.join(root, "skills"), status: "local/custom", excludedDirs: new Set([".system"]) });
  await collectPluginSkills({ ...context, pluginCacheDir: resolvedPluginCacheDir, pluginConfig });

  skills.sort(compareSkills);
  return { skills, warnings, counts: countByStatus(skills) };
}

export function formatCodexSkillInventory(inventory, { maxChars = Infinity, maxRows = DEFAULT_MAX_ROWS } = {}) {
  const safeInventory = inventory || { skills: [], warnings: [] };
  const rowLimit = Math.max(0, Math.min(maxRows, safeInventory.skills.length));
  for (let visibleRows = rowLimit; visibleRows >= 0; visibleRows -= 1) {
    const html = renderInventory(safeInventory, visibleRows);
    if (html.length <= maxChars) return html;
  }
  return renderInventory(safeInventory, 0);
}

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

async function collectLocalSkills({ codexHome, rootDir, status, excludedDirs = new Set(), warnings, skills, seen }) {
  const entries = await readDirOrWarn(rootDir, warnings, codexHome, "skill root unavailable");
  const baseSkill = { codexHome, status, sourceType: status, pluginKey: "", warnings, skills, seen };
  for (const entry of entries) {
    if (!entry.isDirectory() || excludedDirs.has(entry.name)) continue;
    await collectSkillFile({ ...baseSkill, skillDir: path.join(rootDir, entry.name), fallbackName: entry.name });
  }
}

async function collectPluginSkills({ codexHome, pluginCacheDir, pluginConfig, warnings, skills, seen }) {
  const manifests = await findPluginManifests(pluginCacheDir, warnings, codexHome);
  for (const manifestPath of manifests) {
    const pluginRoot = path.dirname(path.dirname(manifestPath));
    const manifest = await readPluginManifest(manifestPath, warnings, codexHome);
    if (!manifest) continue;

    const manifestSkillsPath = typeof manifest.skills === "string" ? manifest.skills.trim() : "";
    if (!manifestSkillsPath) { addWarning(warnings, "plugin manifest has no skills root", manifestPath, codexHome); continue; }
    const skillsRoot = path.resolve(pluginRoot, manifestSkillsPath);
    if (!isInsidePath(pluginRoot, skillsRoot)) { addWarning(warnings, "plugin skills root outside plugin cache entry", manifestPath, codexHome); continue; }
    const realPluginRoot = await realPathOrWarn(pluginRoot, warnings, codexHome, "plugin cache unavailable");
    const realSkillsRoot = await realPathOrWarn(skillsRoot, warnings, codexHome, "plugin skills root unavailable");
    if (!realPluginRoot || !realSkillsRoot) continue;
    if (!isInsidePath(realPluginRoot, realSkillsRoot)) { addWarning(warnings, "plugin skills root outside plugin cache entry", manifestPath, codexHome); continue; }

    const marketplace = marketplaceName(pluginCacheDir, pluginRoot);
    const pluginName = sanitizeDisplayText(typeof manifest.name === "string" && manifest.name.trim() ? manifest.name.trim() : path.basename(pluginRoot));
    const pluginKey = `${pluginName}@${marketplace}`;
    const status = pluginStatus(pluginConfig, pluginName, marketplace);
    const childEntries = await readDirOrWarn(skillsRoot, warnings, codexHome, "plugin skills root unavailable");
    const baseSkill = { codexHome, status, sourceType: "plugin", pluginKey, warnings, skills, seen, confinementRoot: realSkillsRoot };
    for (const entry of childEntries) {
      if (!entry.isDirectory()) continue;
      await collectSkillFile({ ...baseSkill, skillDir: path.join(skillsRoot, entry.name), fallbackName: entry.name });
    }
  }
}

async function collectSkillFile({ codexHome, skillDir, status, sourceType, pluginKey, fallbackName, warnings, skills, seen, confinementRoot = "" }) {
  const skillPath = path.join(skillDir, "SKILL.md");
  if (confinementRoot) {
    const realSkillPath = await realPathOrWarn(skillPath, warnings, codexHome, "skill file unavailable");
    if (!realSkillPath) return;
    if (!isInsidePath(confinementRoot, realSkillPath)) return addWarning(warnings, "skill file outside plugin skills root", skillPath, codexHome);
  }
  let contents = "";
  try {
    contents = await fs.readFile(skillPath, "utf8");
  } catch {
    addWarning(warnings, "skill file unavailable", skillPath, codexHome);
    return;
  }

  const metadata = parseSkillFrontmatter(contents);
  if (metadata.malformed) addWarning(warnings, "skill frontmatter ignored", skillPath, codexHome);
  const displayName = metadata.name || fallbackName;
  const relativePath = relativeCodexPath(codexHome, skillPath);
  const dedupeKey = [sourceType, pluginKey, displayName, relativePath].join("\0");
  if (seen.has(dedupeKey)) return;
  seen.add(dedupeKey);
  skills.push({ displayName, description: metadata.description || "", status, sourceType, pluginKey, relativePath });
}

async function findPluginManifests(pluginCacheDir, warnings, codexHome) {
  const manifests = [];
  const marketplaces = await readDirOrWarn(pluginCacheDir, warnings, codexHome, "plugin cache unavailable");
  for (const marketplace of marketplaces) {
    if (!marketplace.isDirectory()) continue;
    const marketplaceDir = path.join(pluginCacheDir, marketplace.name);
    const plugins = await readDirOrWarn(marketplaceDir, warnings, codexHome, "plugin cache unavailable");
    for (const plugin of plugins) {
      if (!plugin.isDirectory()) continue;
      const pluginDir = path.join(marketplaceDir, plugin.name);
      const versions = await readDirOrWarn(pluginDir, warnings, codexHome, "plugin cache unavailable");
      for (const version of versions) {
        if (!version.isDirectory()) continue;
        manifests.push(path.join(pluginDir, version.name, ".codex-plugin", "plugin.json"));
      }
    }
  }
  return manifests;
}

async function readDirOrWarn(dir, warnings, codexHome, message) {
  try { return await fs.readdir(dir, { withFileTypes: true }); } catch { addWarning(warnings, message, dir, codexHome); return []; }
}

async function readPluginManifest(manifestPath, warnings, codexHome) {
  try { return JSON.parse(await fs.readFile(manifestPath, "utf8")); } catch { addWarning(warnings, "plugin manifest ignored", manifestPath, codexHome); return null; }
}

async function realPathOrWarn(targetPath, warnings, codexHome, message) {
  try { return await fs.realpath(targetPath); } catch { addWarning(warnings, message, targetPath, codexHome); return ""; }
}

async function readPluginConfig(configPath, warnings, codexHome) {
  let contents = "";
  try { contents = await fs.readFile(configPath, "utf8"); } catch { addWarning(warnings, "Codex config unavailable", configPath, codexHome); return new Map(); }
  const statusByPlugin = new Map();
  let pluginKey = "";
  for (const line of contents.split(/\r?\n/)) {
    const headerMatch = line.match(/^\s*\[plugins\."([^"]+)"\]\s*$/);
    if (headerMatch) {
      pluginKey = headerMatch[1];
      continue;
    }
    if (/^\s*\[/.test(line)) {
      if (/^\s*\[plugins\./.test(line)) addWarning(warnings, "Codex config plugin header ignored", configPath, codexHome);
      pluginKey = "";
      continue;
    }
    if (!pluginKey) continue;
    const enabledMatch = line.match(/^\s*enabled\s*=\s*(true|false)\s*(?:#.*)?$/);
    if (!enabledMatch) {
      if (/^\s*enabled\s*=/.test(line)) addWarning(warnings, "Codex config plugin enabled value ignored", configPath, codexHome);
      continue;
    }
    statusByPlugin.set(pluginKey, enabledMatch[1] === "true" ? "plugin enabled" : "plugin disabled");
  }
  return statusByPlugin;
}

function parseSkillFrontmatter(contents) {
  if (!contents.startsWith("---")) return {};
  const lines = contents.split(/\r?\n/);
  if (lines[0] !== "---") return {};
  const metadata = { malformed: false };
  let closed = false;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === "---") { closed = true; break; }
    if (/^\s/.test(line)) continue;
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) { if (line.trim()) metadata.malformed = true; continue; }
    const key = match[1];
    if (key !== "name" && key !== "description") continue;
    const value = stripQuotedScalar(match[2].trim());
    if (value) metadata[key] = value;
  }
  if (!closed) metadata.malformed = true;
  return metadata;
}

function stripQuotedScalar(value) {
  const quote = value[0];
  return value.length >= 2 && (quote === '"' || quote === "'") && value[value.length - 1] === quote ? value.slice(1, -1) : value;
}

function pluginStatus(pluginConfig, pluginName, marketplace) {
  const variants = [marketplace];
  if (marketplace.endsWith("-remote")) variants.push(marketplace.slice(0, -"remote".length - 1));
  for (const variant of variants) {
    const status = pluginConfig.get(`${pluginName}@${variant}`);
    if (status) return status;
  }
  return "plugin cached";
}

function marketplaceName(pluginCacheDir, pluginRoot) {
  const relative = path.relative(pluginCacheDir, pluginRoot);
  const [marketplace] = relative.split(path.sep);
  return marketplace || "unknown";
}

function addWarning(warnings, message, targetPath, codexHome) {
  warnings.push({ message: sanitizeDisplayText(message), target: sanitizeDisplayText(relativeCodexPath(codexHome, targetPath)) });
}

function relativeCodexPath(codexHome, targetPath) {
  const relative = path.relative(codexHome, targetPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return "CODEX_HOME";
  return `CODEX_HOME/${relative.split(path.sep).join("/")}`;
}

function sanitizeDisplayText(value) {
  return String(value).replace(ABSOLUTE_POSIX_PATH_PATTERN, "$1[path]");
}

function compareSkills(left, right) {
  const statusDelta = STATUS_ORDER.indexOf(left.status) - STATUS_ORDER.indexOf(right.status);
  if (statusDelta !== 0) return statusDelta;
  return left.displayName.localeCompare(right.displayName, "en", { sensitivity: "base" });
}

function countByStatus(skills) {
  const counts = Object.fromEntries(STATUS_ORDER.map((status) => [status, 0]));
  for (const skill of skills) counts[skill.status] = (counts[skill.status] || 0) + 1;
  return counts;
}

function renderInventory(inventory, visibleRows) {
  const skills = inventory.skills || [];
  const counts = inventory.counts || countByStatus(skills);
  const visibleSkills = skills.slice(0, visibleRows);
  const lines = [
    b("Codex skills"),
    `Summary: ${STATUS_ORDER.map((status) => `${escapeHtml(status)} ${counts[status] || 0}`).join("; ")}`,
    "Status is observable install/cache/config state, not per-session trigger state.",
    `Warnings: ${escapeHtml(String((inventory.warnings || []).length))} sanitized`
  ];

  for (const status of STATUS_ORDER) {
    const group = visibleSkills.filter((skill) => skill.status === status);
    if (group.length === 0) continue;
    lines.push("", b(status));
    for (const skill of group) lines.push(renderSkillRow(skill));
  }

  const omitted = skills.length - visibleSkills.length;
  if (omitted > 0) lines.push("", `${escapeHtml(String(omitted))} more omitted.`);
  return lines.join("\n");
}

function renderSkillRow(skill) {
  const description = skill.description ? ` - ${escapeHtml(sanitizeDisplayText(skill.description))}` : "";
  const plugin = skill.pluginKey ? ` ${code(sanitizeDisplayText(skill.pluginKey))}` : "";
  return `- ${escapeHtml(sanitizeDisplayText(skill.displayName))}${plugin}${description}`;
}

function isInsidePath(root, target) {
  const relative = path.relative(root, target);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}
