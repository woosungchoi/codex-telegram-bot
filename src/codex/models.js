import fs from "node:fs/promises";

const MODEL_SLUG_PATTERN = /^[A-Za-z0-9._-]{1,54}$/;
const REASONING_EFFORT_PATTERN = /^[a-z0-9][a-z0-9_-]{0,49}$/;

const LEGACY_REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"];
const SOL_REASONING = [
  ["low", "Fast responses with lighter reasoning"],
  ["medium", "Balances speed and reasoning depth for everyday tasks"],
  ["high", "Greater reasoning depth for complex problems"],
  ["xhigh", "Extra high reasoning depth for complex problems"],
  ["max", "Maximum reasoning depth for the hardest problems"],
  ["ultra", "Maximum reasoning with automatic task delegation"]
];
const LUNA_REASONING = SOL_REASONING.slice(0, 5);

const FALLBACK_MODEL_DEFINITIONS = [
  ["gpt-5.6-sol", "GPT-5.6-Sol", true, "low", SOL_REASONING],
  ["gpt-5.6-terra", "GPT-5.6-Terra", true, "medium", SOL_REASONING],
  ["gpt-5.6-luna", "GPT-5.6-Luna", true, "medium", LUNA_REASONING],
  ["gpt-5.5", "GPT-5.5", true, "", LEGACY_REASONING_EFFORTS],
  ["gpt-5.4", "GPT-5.4", true, "", LEGACY_REASONING_EFFORTS],
  ["gpt-5.4-mini", "GPT-5.4 Mini", false, "", LEGACY_REASONING_EFFORTS],
  ["gpt-5.3-codex", "GPT-5.3 Codex", false, "", LEGACY_REASONING_EFFORTS],
  ["gpt-5.3-codex-spark", "GPT-5.3 Codex Spark", false, "", LEGACY_REASONING_EFFORTS],
  ["gpt-5.2", "GPT-5.2", false, "", LEGACY_REASONING_EFFORTS]
];

export async function readCodexModelCatalog(cacheFile) {
  try {
    const parsed = JSON.parse(await fs.readFile(cacheFile, "utf8"));
    const rawModels = Array.isArray(parsed?.models) ? parsed.models : [];
    const models = uniqueModels(
      rawModels
        .filter(
          (model) => model?.slug && (model.visibility === "list" || model.supported_in_api !== false)
        )
        .sort((left, right) => (left.priority ?? 999) - (right.priority ?? 999))
        .map(normalizeModel)
        .filter(Boolean)
    ).slice(0, 12);
    return models.length > 0 ? models : fallbackModels();
  } catch {
    return fallbackModels();
  }
}

export function findCodexModel(models, modelSlug) {
  if (!Array.isArray(models) || typeof modelSlug !== "string") return undefined;
  const slug = modelSlug.trim();
  const exact = models.find((model) => model?.slug === slug);
  if (exact) return exact;
  return slug === "gpt-5.6" ? models.find((model) => model?.slug === "gpt-5.6-sol") : undefined;
}

export function reasoningOptionsForModel(models, modelSlug) {
  const model = findCodexModel(models, modelSlug);
  const options = model
    ? Array.isArray(model.supportedReasoning)
      ? model.supportedReasoning
      : []
    : legacyReasoningOptions();
  return options.map(({ effort, description }) => ({ effort, description }));
}

export function isReasoningEffortSupported(models, modelSlug, effort) {
  const normalized = normalizeEffort(effort);
  return Boolean(
    normalized && reasoningOptionsForModel(models, modelSlug).some((option) => option.effort === normalized)
  );
}

function normalizeModel(model) {
  const slug = normalizeSlug(model.slug);
  if (!slug) return null;
  const supportedReasoning = normalizeReasoningOptions(model.supported_reasoning_levels);
  const advertisedDefault = normalizeEffort(model.default_reasoning_level);
  return {
    slug,
    displayName:
      typeof model.display_name === "string" && model.display_name.length > 0
        ? model.display_name
        : slug,
    fastSupported: hasFastServiceTier(model),
    defaultReasoning: supportedReasoning.some((option) => option.effort === advertisedDefault)
      ? advertisedDefault
      : "",
    supportedReasoning
  };
}

function normalizeSlug(value) {
  if (typeof value !== "string") return "";
  const slug = value.trim();
  return MODEL_SLUG_PATTERN.test(slug) ? slug : "";
}

function normalizeEffort(value) {
  if (typeof value !== "string") return "";
  const effort = value.trim().toLowerCase();
  return REASONING_EFFORT_PATTERN.test(effort) ? effort : "";
}

function normalizeReasoningOptions(entries) {
  if (!Array.isArray(entries)) return [];
  const seen = new Set();
  const options = [];
  for (const entry of entries) {
    const effort = normalizeEffort(typeof entry === "string" ? entry : entry?.effort);
    if (!effort || seen.has(effort)) continue;
    seen.add(effort);
    options.push({
      effort,
      description:
        typeof entry === "object" && entry !== null && typeof entry.description === "string"
          ? entry.description
          : ""
    });
    if (options.length === 12) break;
  }
  return options;
}

function hasFastServiceTier(model) {
  if (Array.isArray(model.additional_speed_tiers) && model.additional_speed_tiers.includes("fast")) {
    return true;
  }
  if (!Array.isArray(model.service_tiers)) return false;
  return model.service_tiers.some((tier) => {
    const id = String(tier?.id ?? tier?.name ?? tier).toLowerCase();
    return id === "fast";
  });
}

function uniqueModels(models) {
  const seen = new Set();
  return models.filter((model) => {
    if (seen.has(model.slug)) return false;
    seen.add(model.slug);
    return true;
  });
}

function legacyReasoningOptions() {
  return LEGACY_REASONING_EFFORTS.map((effort) => ({ effort, description: "" }));
}

function fallbackModels() {
  return FALLBACK_MODEL_DEFINITIONS.map(
    ([slug, displayName, fastSupported, defaultReasoning, reasoning]) => ({
      slug,
      displayName,
      fastSupported,
      defaultReasoning,
      supportedReasoning: reasoning.map((option) => {
        const [effort, description = ""] = Array.isArray(option) ? option : [option];
        return { effort, description };
      })
    })
  );
}
