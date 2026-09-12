import { randomBytes, randomUUID } from "node:crypto";
import { b, code, escapeHtml } from "../telegram/html.js";
import { selectedAccountId } from "./context.js";
import { resetCreditChoices } from "./reset_credits.js";

const PAGE_SIZE = 8;
const FLOW_TTL = 5 * 60_000;
const OUTCOME_TEXT = { reset: "resetDone", alreadyRedeemed: "resetAlreadyDone", nothingToReset: "resetNotNeeded", noCredit: "resetNoCredit" };

export function createResetCreditsController(r, { store, readUsage, consumeCredit, showUsage, text: t, keyboard, button, flowKey, readFlow, clearFlow, now }) {
  const busyAccounts = new Set();
  const date = (ms) => r.formatDateTime ? r.formatDateTime(ms) : new Date(ms).toISOString();
  const title = (choice) => choice.automatic ? t("resetAutomatic") : choice.title?.trim() || t("usageResetCredit");
  const navigation = (id) => [
    [button(t("usageRefresh"), `acct:reset:${id}`)],
    [button(t("usageButton"), `acct:usage:${id}`), button(t("menu"), "acct:list")]
  ];
  const detail = (choice) => [
    b(title(choice)),
    choice.automatic ? t("resetAutomaticHint") : `${t("usageResetExpires")}: ${code(choice.expiresAt == null ? t("usageUnknown") : date(choice.expiresAt * 1000))}`,
    choice.description ? escapeHtml(choice.description) : ""
  ].filter(Boolean).join("\n");

  async function replyFlow(ctx, flow, html, rows) {
    const message = await r.replyHtml(ctx, html, keyboard(rows));
    r.state.accountUi ||= {};
    r.state.accountUi[flowKey(ctx)] = { ...flow, promptId: message.message_id, expiresAt: now() + FLOW_TTL };
    await r.saveState();
  }
  async function validFlow(ctx, token, kind) {
    const flow = readFlow(ctx);
    if (!flow || flow.kind !== kind || flow.token !== token || flow.expiresAt <= now()
      || flow.promptId !== ctx.callbackQuery?.message?.message_id) {
      if (flow?.expiresAt <= now()) await clearFlow(ctx);
      await r.replyHtml(ctx, t("uiExpired"), keyboard([[button(t("menu"), "acct:list")]]));
      return null;
    }
    return flow;
  }
  async function confirmation(ctx, account, attempt, retry = false) {
    const token = randomBytes(8).toString("hex");
    return replyFlow(ctx, { kind: "reset-confirm", token, accountId: account.id, attempt, retry }, [
      b(t("resetConfirmTitle")), `${t("usageAccount")}: ${b(account.label)}`,
      detail(attempt), retry ? t("resetUncertain") : t("resetConfirmHint")
    ].join("\n\n"), [
      [button(t(retry ? "resetRetry" : "resetConfirm"), `acct:resetconfirm:${token}`)],
      [button(t("cancel"), `acct:cancelui:${token}`)],
      ...navigation(account.id)
    ]);
  }
  async function renderList(ctx, flow, page = 0) {
    const pages = Math.max(1, Math.ceil(flow.choices.length / PAGE_SIZE));
    if (!Number.isInteger(page) || page < 0 || page >= pages) return;
    const rows = [], lines = [b(t("resetTitle")), `${t("usageAccount")}: ${b(flow.label)}`,
      `${t("usageResetAvailable")}: ${b(flow.availableCount)}`, "", t("resetChoose")];
    for (const [offset, choice] of flow.choices.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).entries()) {
      const index = page * PAGE_SIZE + offset;
      lines.push("", `${index + 1}. ${detail(choice)}`);
      rows.push([button(`🎟️ ${index + 1}. ${title(choice).slice(0, 48)}`, `acct:resetpick:${flow.token}-${index}`)]);
    }
    if (!flow.choices.length) lines.push("", t("resetNoCredit"));
    if (pages > 1) rows.push([
      ...(page > 0 ? [button("◀️", `acct:resetpage:${flow.token}-${page - 1}`)] : []),
      button(`${page + 1}/${pages}`, `acct:resetpage:${flow.token}-${page}`),
      ...(page + 1 < pages ? [button("▶️", `acct:resetpage:${flow.token}-${page + 1}`)] : [])
    ]);
    rows.push(...flow.accounts.map((account) => [button(`${account.id === flow.accountId ? "✅ " : ""}${account.label}`, `acct:reset:${account.id}`)]));
    rows.push(...navigation(flow.accountId));
    return replyFlow(ctx, flow, lines.join("\n"), rows);
  }
  async function show(ctx, requestedId) {
    const id = requestedId || selectedAccountId(r.getChatState(r.getChatKey(ctx)));
    let account;
    try {
      const accounts = await store.list();
      account = accounts.find((item) => item.id === id);
      if (!account) return r.replyHtml(ctx, t("usageAccountMissing"), keyboard([[button(t("menu"), "acct:list")]]));
      if (account.status === "pending") return r.replyHtml(ctx, t("usagePending"), keyboard(navigation(id)));
      const attempt = r.state.accountResetAttempts?.[id];
      if (attempt) return confirmation(ctx, account, attempt, true);
      const release = await store.acquire(id, { allowUnavailable: true });
      let usage;
      try { usage = await readUsage(r.config, id); } finally { await release(); }
      const summary = usage.rateLimitResetCredits;
      const message = usage.account?.type !== "chatgpt" ? t("usageSignIn")
        : !Number.isInteger(summary?.availableCount) || summary.availableCount < 0 ? t("usageResetCreditsUnavailable") : "";
      if (message) return r.replyHtml(ctx, `${b(account.label)}\n\n${message}`, keyboard(navigation(id)));
      return renderList(ctx, {
        kind: "reset-list", token: randomBytes(8).toString("hex"), accountId: id, label: account.label,
        accounts: accounts.map(({ id, label }) => ({ id, label })),
        choices: resetCreditChoices(summary, now()), availableCount: summary.availableCount
      });
    } catch {
      return r.replyHtml(ctx, [b(t("resetTitle")), account ? b(account.label) : "", t("resetLoadFailed")].filter(Boolean).join("\n\n"), keyboard(navigation(id)));
    }
  }
  async function pickOrPage(ctx, value, pageOnly) {
    const [token, rawIndex] = String(value || "").split("-");
    const flow = await validFlow(ctx, token, "reset-list");
    if (!flow) return;
    const index = /^\d+$/.test(rawIndex || "") ? Number(rawIndex) : -1;
    if (pageOnly) return renderList(ctx, flow, index);
    const choice = flow.choices[index];
    if (!choice) return;
    if (choice.expiresAt != null && choice.expiresAt * 1000 <= now()) {
      await clearFlow(ctx);
      return show(ctx, flow.accountId);
    }
    const account = await store.get(flow.accountId);
    const pending = r.state.accountResetAttempts?.[account.id];
    return confirmation(ctx, account, pending || { ...choice, idempotencyKey: randomUUID() }, Boolean(pending));
  }
  async function confirm(ctx, token) {
    const flow = await validFlow(ctx, token, "reset-confirm");
    if (!flow) return;
    const id = flow.accountId;
    if (busyAccounts.has(id)) return r.replyHtml(ctx, t("resetBusy"), keyboard(navigation(id)));
    busyAccounts.add(id);
    let release;
    try {
      const account = await store.get(id);
      if (account.status === "pending") return r.replyHtml(ctx, t("usagePending"), keyboard(navigation(id)));
      const pending = r.state.accountResetAttempts?.[id];
      if (pending && pending.idempotencyKey !== flow.attempt.idempotencyKey) return confirmation(ctx, account, pending, true);
      // A stale retry must never turn into a new redemption after another prompt resolved it.
      if (flow.retry && !pending) {
        await clearFlow(ctx);
        return showUsage(ctx, id, t("uiExpired"));
      }
      if (!pending && flow.attempt.expiresAt != null && flow.attempt.expiresAt * 1000 <= now()) {
        await clearFlow(ctx);
        return show(ctx, id);
      }
      release = await store.acquire(id, { allowUnavailable: true });
      r.state.accountResetAttempts ||= {};
      r.state.accountResetAttempts[id] = flow.attempt;
      delete r.state.accountUi[flowKey(ctx)];
      // Persist the exact account, credit and idempotency key before making the mutating RPC.
      // Navigation and process restarts must not turn a lost response into a second credit.
      await r.saveState();
      let result;
      try {
        result = await consumeCredit(r.config, id, {
          idempotencyKey: flow.attempt.idempotencyKey,
          ...(flow.attempt.creditId == null ? {} : { creditId: flow.attempt.creditId })
        });
        if (!OUTCOME_TEXT[result?.outcome]) throw new Error("Unknown reset outcome.");
      } catch {
        return confirmation(ctx, account, flow.attempt, true);
      }
      delete r.state.accountResetAttempts[id];
      try { await r.saveState(); } catch (error) {
        r.state.accountResetAttempts[id] = flow.attempt;
        throw error;
      }
      return showUsage(ctx, id, t(OUTCOME_TEXT[result.outcome]));
    } finally {
      try { if (release) await release(); } finally { busyAccounts.delete(id); }
    }
  }
  return { show, pick: (ctx, value) => pickOrPage(ctx, value, false), page: (ctx, value) => pickOrPage(ctx, value, true), confirm };
}
