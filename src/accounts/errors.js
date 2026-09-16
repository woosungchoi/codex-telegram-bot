export function codexEventError(event) {
  if (event?.type !== "error" && event?.type !== "turn.failed" && event?.method !== "error"
    && !(event?.method === "turn/completed" && event.params?.turn?.status === "failed")) return null;
  const source = event.params?.turn?.error || event.params?.error || event.error || event;
  const error = new Error(typeof source === "string" ? source : source.message || "Codex turn failed.");
  error.codexErrorInfo = source.codexErrorInfo;
  error.code = source.code;
  error.willRetry = event.params?.willRetry === true || event.willRetry === true
    || /^Reconnecting\.\.\. \d+\/\d+/.test(error.message);
  return error;
}

export function classifyAccountFailure(error, now = Date.now()) {
  const info = error?.codexErrorInfo;
  const status = typeof info === "object" && info
    ? Object.values(info).find((v) => v?.httpStatusCode)?.httpStatusCode : null;
  const message = String(error?.message || "");
  if (error?.willRetry || /abort|cancel|stop requested/i.test(message)) return null;
  if (info === "usageLimitExceeded" || error?.code === "insufficient_quota"
    || /usage limit|usage_limit_reached|insufficient_quota|quota exceeded|out of credits|hit your.*limit/i.test(message)) {
    return { kind: "quota", retryAt: now + 15 * 60_000 };
  }
  if (status === 401 || /refresh_token_reused|refresh token.*expired|authentication token.*expired|unauthorized|not logged in|sign in again|needs sign-in/i.test(message)) {
    return { kind: "auth", retryAt: now + 15 * 60_000 };
  }
  // A generic 429 can be service-wide. Rotate only a confirmed account quota
  // failure; network, context, model, permission and malformed-request errors
  // retain the CLI's own recovery behavior.
  return null;
}

export function hasAttemptActivity(event) {
  return ["item.started", "item.updated", "item.completed"].includes(event?.type)
    || /^item\//.test(event?.method || "")
    || event?.method === "rawResponseItem/completed";
}
