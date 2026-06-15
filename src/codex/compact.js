const COMPACT_PROMPTS = {
  light: [
    "Compact the conversation without changing the active thread.",
    "Preserve the user's current goal, constraints, decisions, open questions, touched files, commands run, verification results, and concrete next steps.",
    "Keep more recent details when they may affect the next turn. Summarize long logs and tool outputs instead of copying them."
  ].join("\n"),
  balanced: [
    "Compact the conversation without changing the active thread.",
    "Keep the user's current goal, explicit preferences, relevant files, decisions, commands run, verification results, risks, and the next actionable steps.",
    "Discard repetitive progress chatter, stale branches of investigation, and long raw outputs after summarizing any result that still matters."
  ].join("\n"),
  aggressive: [
    "Compact the conversation without changing the active thread.",
    "Keep only the information needed to continue safely: current goal, hard constraints, relevant files, decisions, commands run, verification results, unresolved risks, and next steps.",
    "Drop stale discussion, detailed logs, repeated tool output, and low-value intermediate reasoning."
  ].join("\n")
};

export function buildCodexCompactConfig(config) {
  const codexConfig = {};
  if (config.codexModelContextWindow > 0) {
    codexConfig.model_context_window = config.codexModelContextWindow;
  }

  const autoCompactTokenLimit = resolveAutoCompactTokenLimit(config);
  if (autoCompactTokenLimit > 0) {
    codexConfig.model_auto_compact_token_limit = autoCompactTokenLimit;
  }

  if (config.codexToolOutputTokenLimit > 0) {
    codexConfig.tool_output_token_limit = config.codexToolOutputTokenLimit;
  }

  if (config.codexCompactPromptFile) {
    codexConfig.experimental_compact_prompt_file = config.codexCompactPromptFile;
  } else {
    const prompt = compactPromptForStrength(config.codexCompactStrength);
    if (prompt) codexConfig.compact_prompt = prompt;
  }

  return codexConfig;
}

export function compactPromptForStrength(strength) {
  return COMPACT_PROMPTS[strength] || "";
}

export function resolveAutoCompactTokenLimit(config) {
  if (config.codexAutoCompactTokenLimit > 0) return config.codexAutoCompactTokenLimit;
  if (config.codexModelContextWindow > 0 && config.codexContextCompactThresholdPercent > 0) {
    return Math.floor(config.codexModelContextWindow * (config.codexContextCompactThresholdPercent / 100));
  }
  return 0;
}

export function analyzeContextPressure(tokenCount) {
  const info = tokenCount?.info && typeof tokenCount.info === "object" ? tokenCount.info : tokenCount;
  if (!info || typeof info !== "object") return null;

  const usage = firstObject(info.last_token_usage, info.total_token_usage, info.usage);
  const inputTokens = firstFiniteNumber(
    usage?.input_tokens,
    usage?.total_tokens,
    info.input_tokens,
    info.total_tokens
  );
  const modelContextWindow = firstFiniteNumber(
    info.model_context_window,
    tokenCount?.model_context_window
  );
  if (!inputTokens || !modelContextWindow) return null;

  const remainingTokens = Math.max(0, modelContextWindow - inputTokens);
  return {
    inputTokens,
    modelContextWindow,
    remainingTokens,
    percent: Math.min(100, (inputTokens / modelContextWindow) * 100)
  };
}

function firstObject(...values) {
  return values.find((value) => value && typeof value === "object" && !Array.isArray(value)) || null;
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
}
