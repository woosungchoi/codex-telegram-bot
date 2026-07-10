import { findCodexModel, isReasoningEffortSupported } from "./models.js";

export function mergeAdditionalDirectories(configuredDirectories = [], uploadDir = "") {
  return [...new Set([...configuredDirectories, uploadDir].filter(Boolean))];
}

export function planModelReasoningTransition({
  models,
  modelSlug,
  explicitReasoning,
  configuredReasoning,
  allowExplicitClear = false
}) {
  if (!findCodexModel(models, modelSlug)) return { action: "keep" };

  const hasExplicitReasoning = explicitReasoning !== undefined;
  const effectiveReasoning = hasExplicitReasoning ? explicitReasoning : configuredReasoning;
  if (isReasoningEffortSupported(models, modelSlug, effectiveReasoning)) {
    return { action: "keep" };
  }
  if (
    hasExplicitReasoning
    && allowExplicitClear
    && isReasoningEffortSupported(models, modelSlug, configuredReasoning)
  ) {
    return { action: "clear" };
  }
  return { action: "reject", reasoning: effectiveReasoning };
}
