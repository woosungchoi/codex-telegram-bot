import { connectAppServer } from "../codex/app_server.js";
import { accountConfig } from "./context.js";

const OUTCOMES = new Set(["reset", "alreadyRedeemed", "nothingToReset", "noCredit"]);

export async function consumeAccountResetCredit(config, id, { idempotencyKey, creditId }, { connect = connectAppServer } = {}) {
  if (typeof idempotencyKey !== "string" || !idempotencyKey.trim()) throw new Error("A reset attempt ID is required.");
  if (creditId != null && (typeof creditId !== "string" || !creditId.trim())) throw new Error("Invalid reset credit.");
  const client = await connect(accountConfig(config, id));
  try {
    const { account } = await client.request("account/read", { refreshToken: false });
    if (account?.type !== "chatgpt") throw new Error("Reset credits require a ChatGPT sign-in.");
    const result = await client.request("account/rateLimitResetCredit/consume", {
      idempotencyKey, ...(creditId == null ? {} : { creditId })
    });
    if (!OUTCOMES.has(result?.outcome)) throw new Error("Unknown reset result. Recheck the same attempt.");
    return { outcome: result.outcome };
  } finally { await client.close(); }
}

export function resetCreditChoices(summary, now = Date.now()) {
  if (!Number.isInteger(summary?.availableCount) || summary.availableCount <= 0) return [];
  const seen = new Set();
  const choices = [];
  for (const credit of Array.isArray(summary.credits) ? summary.credits : []) {
    if (!credit || credit.status !== "available" || credit.resetType !== "codexRateLimits"
      || typeof credit.id !== "string" || !credit.id.trim() || seen.has(credit.id)
      || (credit.expiresAt != null && (!Number.isFinite(credit.expiresAt) || credit.expiresAt * 1000 <= now))) continue;
    seen.add(credit.id);
    choices.push({
      creditId: credit.id,
      title: typeof credit.title === "string" ? credit.title.slice(0, 80) : "",
      description: typeof credit.description === "string" ? credit.description.slice(0, 300) : "",
      expiresAt: credit.expiresAt ?? null
    });
  }
  // Count-only and capped responses still support the server's next-credit selection.
  if (summary.availableCount > choices.length) choices.push({ automatic: true });
  return choices;
}
