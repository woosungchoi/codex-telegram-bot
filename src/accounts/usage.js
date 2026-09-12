import { connectAppServer } from "../codex/app_server.js";
import { b, code, escapeHtml } from "../telegram/html.js";
import { accountConfig } from "./context.js";

export async function readAccountUsage(config, id, { connect = connectAppServer, now = Date.now } = {}) {
  const client = await connect(accountConfig(config, id));
  try {
    const { account } = await client.request("account/read", { refreshToken: false });
    const identity = account ? { type: account.type, email: account.email, planType: account.planType } : null;
    const limits = account?.type === "chatgpt" ? await client.request("account/rateLimits/read", {}) : null;
    return {
      account: identity,
      rateLimits: limits?.rateLimits ?? null,
      rateLimitsByLimitId: limits?.rateLimitsByLimitId ?? null,
      rateLimitResetCredits: limits?.rateLimitResetCredits ?? null,
      checkedAt: now()
    };
  } finally { await client.close(); }
}

export function formatAccountUsageHtml(usage, { label, text: t, formatDateTime = (ms) => new Date(ms).toISOString() }) {
  const identity = usage.account;
  const lines = [b(t("usageTitle")), "", `${t("usageAccount")}: ${b(label)}${identity?.planType ? ` · ${b(identity.planType)}` : ""}`];
  if (identity?.email && identity.email !== label) lines.push(code(identity.email));
  if (identity?.type !== "chatgpt") {
    lines.push("", t("usageSignIn"));
  } else {
    const pools = new Map();
    if (usage.rateLimits) pools.set(usage.rateLimits.limitId || "codex", usage.rateLimits);
    for (const [id, pool] of Object.entries(usage.rateLimitsByLimitId || {})) {
      if (pool) pools.set(pool.limitId || id, pool);
    }
    let count = 0;
    for (const [id, pool] of pools) {
      for (const window of [pool.primary, pool.secondary].filter(Boolean)) {
        const percent = Number.isFinite(window.usedPercent) ? window.usedPercent : null;
        const used = percent == null ? t("usageUnknown") : `${percent}%`;
        const left = percent == null ? t("usageUnknown") : `${Math.max(0, Math.min(100, 100 - percent))}%`;
        const reset = Number.isFinite(window.resetsAt) && window.resetsAt > 0
          ? formatDateTime(window.resetsAt * 1000) : t("usageUnknown");
        lines.push("", b(`${pool.limitName || (id === "codex" ? "Codex" : id)} · ${windowLabel(window.windowDurationMins, t)}`),
          `${t("usageUsed")} ${escapeHtml(used)} · ${t("usageLeft")} ${b(left)}`,
          `${t("usageReset")}: ${code(reset)}`);
        count++;
      }
    }
    if (!count) lines.push("", t("usageUnavailable"));
    lines.push("", ...formatResetCredits(usage.rateLimitResetCredits, t, formatDateTime));
  }
  lines.push("", `${t("usageChecked")}: ${code(formatDateTime(usage.checkedAt))}`);
  return lines.join("\n");
}

function formatResetCredits(resetCredits, t, formatDateTime) {
  const lines = [b(t("usageResetCredits"))];
  if (!resetCredits) return [...lines, t("usageResetCreditsUnavailable")];
  // Detail rows may be capped by the service; only availableCount is authoritative.
  const count = Number.isInteger(resetCredits.availableCount) && resetCredits.availableCount >= 0
    ? resetCredits.availableCount : null;
  lines.push(`${t("usageResetAvailable")}: ${b(count ?? t("usageUnknown"))}`);
  const credits = Array.isArray(resetCredits.credits) ? resetCredits.credits.filter(Boolean).slice(0, 5) : [];
  for (const [index, credit] of credits.entries()) {
    const title = typeof credit.title === "string" && credit.title.trim()
      ? credit.title.slice(0, 80) : t("usageResetCredit");
    const expires = Number.isFinite(credit.expiresAt) && credit.expiresAt > 0
      ? formatDateTime(credit.expiresAt * 1000) : t("usageUnknown");
    lines.push(`${index + 1}. ${escapeHtml(title)} · ${t("usageResetExpires")}: ${code(expires)}`);
  }
  if (count > credits.length) lines.push(`${t("usageResetDetails")}: ${credits.length}/${count}`);
  if (!Array.isArray(resetCredits.credits)) lines.push(t("usageResetDetailsUnavailable"));
  return lines;
}

function windowLabel(minutes, t) {
  if (minutes === 10080) return t("usageWeekly");
  if (!Number.isFinite(minutes) || minutes <= 0) return t("usageWindow");
  if (minutes % 1440 === 0) return `${minutes / 1440}${t("usageDays")}`;
  if (minutes % 60 === 0) return `${minutes / 60}${t("usageHours")}`;
  return `${minutes}${t("usageMinutes")}`;
}
