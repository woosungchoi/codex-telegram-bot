import fs from "node:fs/promises";
import path from "node:path";
import { addWarning, countByStatus, isInsidePath, relativeCodexPath, sanitizeDisplayText, STATUS_ORDER } from "./skills_shared.js";

export async function collectCodexSkillInventory({ codexHome, pluginCacheDir, configPath } = {}) {
  const root = path.resolve(codexHome || "");
  const warnings = [], skills = [], seen = new Set();
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

async function collectLocalSkills({ codexHome, rootDir, status, excludedDirs = new Set(), warnings, skills, seen }) {
  const entries = await readDirOrWarn(rootDir, warnings, codexHome, "skill root unavailable"), baseSkill = { codexHome, status, sourceType: status, pluginKey: "", warnings, skills, seen };
  for (const entry of entries.filter((entry) => entry.isDirectory() && !excludedDirs.has(entry.name))) {
    await collectSkillFile({ ...baseSkill, skillDir: path.join(rootDir, entry.name), fallbackName: entry.name });
  }
}

async function collectPluginSkills({ codexHome, pluginCacheDir, pluginConfig, warnings, skills, seen }) {
  const manifests = await findPluginManifests(pluginCacheDir, warnings, codexHome);
  for (const manifestPath of manifests) {
    const pluginRoot = path.dirname(path.dirname(manifestPath)), manifest = await readPluginManifest(manifestPath, warnings, codexHome);
    if (!manifest)
      continue;

    const manifestSkillsPath = typeof manifest.skills === "string" ? manifest.skills.trim() : "";
    if (!manifestSkillsPath) {
      addWarning(warnings, "plugin manifest has no skills root", manifestPath, codexHome);
      continue;
    }
    const skillsRoot = path.resolve(pluginRoot, manifestSkillsPath);
    if (!isInsidePath(pluginRoot, skillsRoot)) {
      addWarning(warnings, "plugin skills root outside plugin cache entry", manifestPath, codexHome);
      continue;
    }
    const realPluginRoot = await realPathOrWarn(pluginRoot, warnings, codexHome, "plugin cache unavailable"), realSkillsRoot = await realPathOrWarn(skillsRoot, warnings, codexHome, "plugin skills root unavailable");
    if (!realPluginRoot || !realSkillsRoot)
      continue;
    if (!isInsidePath(realPluginRoot, realSkillsRoot)) {
      addWarning(warnings, "plugin skills root outside plugin cache entry", manifestPath, codexHome);
      continue;
    }

    const marketplace = path.relative(pluginCacheDir, pluginRoot).split(path.sep)[0] || "unknown", pluginName = sanitizeDisplayText(typeof manifest.name === "string" && manifest.name.trim() ? manifest.name.trim() : path.basename(pluginRoot)), pluginKey = `${pluginName}@${marketplace}`, status = pluginStatus(pluginConfig, pluginName, marketplace), childEntries = await readDirOrWarn(skillsRoot, warnings, codexHome, "plugin skills root unavailable"), baseSkill = { codexHome, status, sourceType: "plugin", pluginKey, warnings, skills, seen, confinementRoot: realSkillsRoot };
    for (const entry of childEntries.filter((entry) => entry.isDirectory())) {
      await collectSkillFile({ ...baseSkill, skillDir: path.join(skillsRoot, entry.name), fallbackName: entry.name });
    }
  }
}

async function collectSkillFile({ codexHome, skillDir, status, sourceType, pluginKey, fallbackName, warnings, skills, seen, confinementRoot = "" }) {
  const skillPath = path.join(skillDir, "SKILL.md");
  if (confinementRoot) {
    const realSkillPath = await realPathOrWarn(skillPath, warnings, codexHome, "skill file unavailable");
    if (!realSkillPath)
      return;
    if (!isInsidePath(confinementRoot, realSkillPath))
      return addWarning(warnings, "skill file outside plugin skills root", skillPath, codexHome);
  }
  let contents = "";
  try {
    contents = await fs.readFile(skillPath, "utf8");
  } catch {
    addWarning(warnings, "skill file unavailable", skillPath, codexHome);
    return;
  }

  const metadata = parseSkillFrontmatter(contents), displayName = metadata.name || fallbackName, relativePath = relativeCodexPath(codexHome, skillPath), dedupeKey = [sourceType, pluginKey, displayName, relativePath].join("\0");
  if (metadata.malformed)
    addWarning(warnings, "skill frontmatter ignored", skillPath, codexHome);
  if (seen.has(dedupeKey))
    return;
  seen.add(dedupeKey);
  skills.push({ displayName, description: metadata.description || "", status, sourceType, pluginKey, relativePath });
}

async function findPluginManifests(pluginCacheDir, warnings, codexHome) {
  const manifests = [];
  const marketplaces = await readDirOrWarn(pluginCacheDir, warnings, codexHome, "plugin cache unavailable");
  for (const marketplace of marketplaces.filter((entry) => entry.isDirectory())) {
    const marketplaceDir = path.join(pluginCacheDir, marketplace.name), plugins = await readDirOrWarn(marketplaceDir, warnings, codexHome, "plugin cache unavailable");
    for (const plugin of plugins.filter((entry) => entry.isDirectory())) {
      const pluginDir = path.join(marketplaceDir, plugin.name), versions = await readDirOrWarn(pluginDir, warnings, codexHome, "plugin cache unavailable");
      for (const version of versions.filter((entry) => entry.isDirectory())) {
        manifests.push(path.join(pluginDir, version.name, ".codex-plugin", "plugin.json"));
      }
    }
  }
  return manifests;
}

async function readDirOrWarn(dir, warnings, codexHome, message) { return readOrWarn(() => fs.readdir(dir, { withFileTypes: true }), [], dir, warnings, codexHome, message); }

async function readPluginManifest(manifestPath, warnings, codexHome) { return readOrWarn(async () => JSON.parse(await fs.readFile(manifestPath, "utf8")), null, manifestPath, warnings, codexHome, "plugin manifest ignored"); }

async function realPathOrWarn(targetPath, warnings, codexHome, message) { return readOrWarn(() => fs.realpath(targetPath), "", targetPath, warnings, codexHome, message); }

async function readOrWarn(operation, fallback, targetPath, warnings, codexHome, message) {
  try {
    return await operation();
  } catch {
    addWarning(warnings, message, targetPath, codexHome);
    return fallback;
  }
}

async function readPluginConfig(configPath, warnings, codexHome) {
  const contents = await readOrWarn(() => fs.readFile(configPath, "utf8"), "", configPath, warnings, codexHome, "Codex config unavailable");
  if (!contents) {
    return new Map();
  }
  const statusByPlugin = new Map();
  let pluginKey = "";
  for (const line of contents.split(/\r?\n/)) {
    const headerMatch = line.match(/^\s*\[plugins\."([^"]+)"\]\s*$/);
    if (headerMatch) {
      pluginKey = headerMatch[1];
      continue;
    }
    if (/^\s*\[/.test(line)) {
      if (/^\s*\[plugins\./.test(line))
        addWarning(warnings, "Codex config plugin header ignored", configPath, codexHome);
      pluginKey = "";
      continue;
    }
    if (!pluginKey)
      continue;
    const enabledMatch = line.match(/^\s*enabled\s*=\s*(true|false)\s*(?:#.*)?$/);
    if (!enabledMatch) {
      if (/^\s*enabled\s*=/.test(line))
        addWarning(warnings, "Codex config plugin enabled value ignored", configPath, codexHome);
      continue;
    }
    statusByPlugin.set(pluginKey, enabledMatch[1] === "true" ? "plugin enabled" : "plugin disabled");
  }
  return statusByPlugin;
}

function parseSkillFrontmatter(contents) {
  if (!contents.startsWith("---"))
    return {};
  const lines = contents.split(/\r?\n/), metadata = { malformed: false };
  if (lines[0] !== "---")
    return {};
  let closed = false;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === "---") {
      closed = true;
      break;
    }
    if (/^\s/.test(line))
      continue;
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) {
      if (line.trim())
        metadata.malformed = true;
      continue;
    }
    const key = match[1];
    if (key !== "name" && key !== "description")
      continue;
    const scalar = match[2].trim();
    if ((scalar === "|" || scalar === ">") && key === "description") {
      const block = readBlockScalar(lines, index + 1, scalar);
      if (block.value)
        metadata[key] = block.value;
      index = block.nextIndex - 1;
      continue;
    }
    const value = stripQuotedScalar(scalar);
    if (value)
      metadata[key] = value;
  }
  if (!closed)
    metadata.malformed = true;
  return metadata;
}

function stripQuotedScalar(value) {
  const quote = value[0];
  return value.length >= 2 && (quote === '"' || quote === "'") && value[value.length - 1] === quote ? value.slice(1, -1) : value;
}

function readBlockScalar(lines, startIndex, marker) {
  const raw = [];
  let index = startIndex;
  for (; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === "---")
      break;
    if (!/^\s/.test(line) && line.trim())
      break;
    raw.push(line);
  }
  return { value: normalizeBlockScalar(raw, marker), nextIndex: index };
}

function normalizeBlockScalar(lines, marker) {
  const indents = lines.filter((line) => line.trim()).map((line) => line.match(/^\s*/)[0].length);
  const indent = indents.length ? Math.min(...indents) : 0;
  const stripped = lines.map((line) => line.trim() ? line.slice(indent) : "");
  return marker === ">" ? stripped.join(" ").replace(/\s+/g, " ").trim() : stripped.join("\n").trim();
}

function pluginStatus(pluginConfig, pluginName, marketplace) {
  const variants = marketplace.endsWith("-remote") ? [marketplace, marketplace.slice(0, -"remote".length - 1)] : [marketplace];
  return variants.map((variant) => pluginConfig.get(`${pluginName}@${variant}`)).find(Boolean) || "plugin cached";
}

function compareSkills(left, right) {
  const statusDelta = STATUS_ORDER.indexOf(left.status) - STATUS_ORDER.indexOf(right.status);
  if (statusDelta !== 0)
    return statusDelta;
  return left.displayName.localeCompare(right.displayName, "en", { sensitivity: "base" });
}
