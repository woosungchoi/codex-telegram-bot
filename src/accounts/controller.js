import { createAccountStore } from "./store.js";
import { selectedAccountId } from "./context.js";
import { signInAccount, inspectAccount } from "./auth.js";
import { accountText } from "./messages.js";
import { b, code, escapeHtml } from "../telegram/html.js";

export function registerAccountCommands(r, { store = createAccountStore(r.config), signIn = signInAccount, inspect = inspectAccount } = {}) {
  const pending = new Map();
  const t = (key) => accountText(r.state.ui?.language || r.config.telegramLanguage, key);
  const keyboard = (rows) => ({ reply_markup: { inline_keyboard: rows } });
  const button = (text, data) => ({ text, callback_data: data });
  async function guard(ctx, action) {
    if (ctx.chat?.type !== "private" || !r.config.allowedUserIds.has(String(ctx.from?.id))
      || !r.config.codexAccountAdminUserIds.has(String(ctx.from?.id))) {
      await ctx.answerCbQuery?.().catch(() => {});
      return r.replyHtml(ctx, t("private"));
    }
    await ctx.answerCbQuery?.().catch(() => {});
    try { return await action(); } catch (error) {
      return r.replyHtml(ctx, `${t("failed")}\n${code(r.redactText?.(error.message) || error.message)}`);
    }
  }
  async function show(ctx, notice = "") {
    const [accounts, settings] = await Promise.all([store.list(), store.read()]);
    const selected = selectedAccountId(r.getChatState(r.getChatKey(ctx)));
    const lines = [b(t("title")), notice, t("instruction"), ""];
    const rows = [];
    for (const account of accounts) {
      const active = account.id === selected ? "✅ " : "";
      lines.push(`${active}${b(account.label)} · ${escapeHtml(t(account.status))}${account.planType ? ` · ${escapeHtml(account.planType)}` : ""}`, code(account.id));
      if (account.usedPercent != null) lines.push(`${t("usage")}: ${Number(account.usedPercent)}%`);
      if (account.cooldownUntil > Date.now()) lines.push(`${t("cooldown")}: ${code(r.formatDateTime?.(account.cooldownUntil) || new Date(account.cooldownUntil).toISOString())}`);
      rows.push([
        button(`${active}${account.label}`, `acct:use:${account.id}`),
        button(t("check"), `acct:check:${account.id}`),
        ...(account.legacy ? [] : [button(t("remove"), `acct:remove:${account.id}`)])
      ]);
    }
    lines.push("", `${t("rotate")}: ${settings.autoRotate ? t("on") : t("off")}`, t("commands"));
    rows.push([button(t("add"), "acct:login"), button(`${t("rotate")} ${settings.autoRotate ? t("off") : t("on")}`, `acct:rotate:${settings.autoRotate ? "off" : "on"}`)]);
    return r.replyHtml(ctx, lines.filter((line) => line !== undefined).join("\n"), keyboard(rows));
  }
  async function use(ctx, id) {
    const account = await store.get(id);
    if (account.status !== "ready") throw new Error("This account needs sign-in. Use /reauth.");
    const chatKey = r.getChatKey(ctx);
    r.getChatState(chatKey).accountId = id;
    r.threadCache.delete(chatKey);
    await r.saveState();
    return show(ctx, t("next"));
  }
  async function begin(ctx, label) {
    const key = String(ctx.from.id);
    if (pending.has(key)) return r.replyHtml(ctx, t("busy"));
    const abort = new AbortController();
    const session = { abort, codeMessage: null };
    pending.set(key, session);
    try { await r.replyHtml(ctx, t("start")); } catch (error) { pending.delete(key); throw error; }
    session.promise = (async () => {
      try {
        const account = await signIn({
          config: r.config, store, label, signal: abort.signal,
          onCode: async ({ verificationUrl, userCode }) => {
            session.codeMessage = await r.replyHtml(ctx,
              `${b("🔐 ChatGPT")}\n${t("code")}\n\n${code(userCode)}`,
              { ...keyboard([[{ text: "🔐 ChatGPT", url: verificationUrl }, button(t("cancel"), "acct:cancel")]]), protect_content: true, link_preview_options: { is_disabled: true } });
          }
        });
        await r.replyHtml(ctx, `${t("done")}\n${b(account.label)}`,
          keyboard([[button(`${t("use")} · ${account.label}`, `acct:use:${account.id}`)]]));
      } catch (error) {
        await r.replyHtml(ctx, abort.signal.aborted ? t("cancelled") : `${t("failed")}\n${code(r.redactText?.(error.message) || error.message)}`).catch(() => {});
      } finally {
        if (session.codeMessage?.message_id) await r.bot.telegram.deleteMessage(ctx.chat.id, session.codeMessage.message_id).catch(() => {});
        pending.delete(key);
      }
    })();
  }
  async function action(ctx, operation, id, value) {
    if (operation === "use") return use(ctx, id);
    if (operation === "rename") { await store.rename(id, value); return show(ctx); }
    if (operation === "rotate") {
      if (!["on", "off"].includes(id)) throw new Error("Use /accounts rotate on or off.");
      await store.setAutoRotate(id === "on");
      return show(ctx);
    }
    if (operation === "check") {
      if ((await store.get(id)).status === "pending") throw new Error("Sign-in is still pending. Complete it or use /reauth cancel.");
      const release = await store.acquire(id, { allowUnavailable: true });
      try { await store.update(id, await inspect(r.config, id)); } finally { await release(); }
      return show(ctx, t("refreshed"));
    }
    if (operation === "remove") {
      const account = await store.get(id);
      return r.replyHtml(ctx, `${t("deleteConfirm")}\n${b(account.label)}`,
        keyboard([[button(t("remove"), `acct:delete:${id}`), button(t("cancel"), "acct:list")]]));
    }
    if (operation === "delete") {
      if ((await store.get(id)).status === "pending" && pending.size) throw new Error("Sign-in is still pending. Use /reauth cancel first.");
      await store.remove(id);
      for (const [key, chat] of Object.entries(r.state.chats || {})) {
        if (chat.accountId === id) chat.accountId = "default";
        if (chat.threadAccountId === id) { delete chat.threadId; delete chat.threadAccountId; }
        if (chat.accountThreads) delete chat.accountThreads[id];
        r.threadCache.delete(key);
      }
      await r.saveState();
      return show(ctx);
    }
    if (operation === "login") return begin(ctx);
    if (operation === "cancel") { pending.get(String(ctx.from.id))?.abort.abort(); return; }
    return show(ctx);
  }
  r.bot.command("accounts", (ctx) => guard(ctx, () => {
    const [operation, id, ...rest] = r.getCommandArgs(ctx).trim().split(/\s+/);
    return action(ctx, operation, id, rest.join(" "));
  }));
  r.bot.command("reauth", (ctx) => guard(ctx, () => {
    const label = r.getCommandArgs(ctx).trim();
    return label === "cancel" ? action(ctx, "cancel") : begin(ctx, label);
  }));
  r.bot.action(/^acct:([a-z]+)(?::([a-z0-9-]+))?$/, (ctx) => guard(ctx, () => action(ctx, ctx.match[1], ctx.match[2])));
  return { pending, show, close: () => { for (const session of pending.values()) session.abort.abort(); } };
}
