// Convert authoritative app-server usage into the existing context/status shape.
// Totals are snapshots, never counters to add on replay.
export function nativeUsageSample(tokenUsage, { threadId, accountId = "default", sampledAt = new Date().toISOString() } = {}) {
  if (!threadId || !tokenUsage?.last || !tokenUsage?.total) return null;
  const convert = (value) => Object.fromEntries([
    ["input_tokens", value.inputTokens], ["cached_input_tokens", value.cachedInputTokens],
    ["output_tokens", value.outputTokens], ["reasoning_output_tokens", value.reasoningOutputTokens],
    ["total_tokens", value.totalTokens]
  ].filter(([, n]) => Number.isFinite(n) && n >= 0));
  return { threadId, accountId, sampledAt, tokenCount: { info: {
    last_token_usage: convert(tokenUsage.last), total_token_usage: convert(tokenUsage.total),
    model_context_window: tokenUsage.modelContextWindow
  } } };
}

export function currentNativeUsage(chat, threadId) {
  const sample = chat?.nativeUsage;
  return sample?.threadId === threadId && sample?.accountId === (chat.threadAccountId || chat.accountId || "default") ? sample : null;
}
