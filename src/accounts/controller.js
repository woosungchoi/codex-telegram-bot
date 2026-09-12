import { randomBytes } from "node:crypto";
import { createAccountStore, cleanLabel } from "./store.js";
import { selectedAccountId } from "./context.js";
import { signInAccount, inspectAccount } from "./auth.js";
import { accountText } from "./messages.js";
import { formatAccountUsageHtml, readAccountUsage } from "./usage.js";
import { b, code, escapeHtml } from "../telegram/html.js";
import { createNavigationKeyboardViews, inlineKeyboard } from "../ui/keyboard_helpers.js";

export function registerAccountCommands(r, { store = createAccountStore(r.config), signIn = signInAccount, inspect = inspectAccount, readUsage = readAccountUsage, now = Date.now } = {}) {
  const pending = new Map();
  const operations = new Map();
  const t = (key) => accountText(r.state.ui?.language || r.config.telegramLanguage, key);
  const navigation = createNavigationKeyboardViews({ text: t });
  const keyboard = (rows) => navigation.withMenuCloseButton(inlineKeyboard(rows));
  const button = (text, data) => ({ text, callback_data: data });
  const flowKey = (ctx) => `${ctx.chat?.id}:${ctx.from?.id}`;
  const readFlow = (ctx) => r.state.accountUi?.[flowKey(ctx)];
  const menuKeyboard = () => keyboard([[button(t("menu"), "acct:list")]]);
  async function serialize(ctx, action) {
    const key = flowKey(ctx);
    const operation = (operations.get(key) || Promise.resolve()).catch(() => {}).then(action);
    operations.set(key, operation);
    try { return await operation; } finally {
      if (operations.get(key) === operation) operations.delete(key);
    }
  }
  async function guard(ctx, action) {
    if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
    if (ctx.chat?.type !== "private" || !r.config.allowedUserIds.has(String(ctx.from?.id))
      || !r.config.codexAccountAdminUserIds.has(String(ctx.from?.id))) {
      return r.replyHtml(ctx, t("private"));
    }
    try { return await serialize(ctx, action); } catch (error) {
      return r.replyHtml(ctx, `${t("failed")}\n${code(r.redactText?.(error.message) || error.message)}`);
    }
  }
  async function clearFlow(ctx) {
    if (!readFlow(ctx)) return;
    delete r.state.accountUi[flowKey(ctx)];
    await r.saveState();
  }
  async function prompt(ctx, kind, accountId, html) {
    const token = randomBytes(8).toString("hex");
    const rows = kind === "delete" ? [[button(t("confirmDelete"), `acct:confirm:${token}`)]] : [];
    rows.push([button(t("cancel"), `acct:cancelui:${token}`)]);
    const message = await r.replyHtml(ctx, html, keyboard(rows));
    r.state.accountUi ||= {};
    r.state.accountUi[flowKey(ctx)] = {
      kind, accountId, token, promptId: message.message_id, expiresAt: now() + 5 * 60_000
    };
    await r.saveState();
  }
  async function promptName(ctx, kind, id) {
    if (kind === "login" && pending.has(String(ctx.from.id))) return r.replyHtml(ctx, t("busy"));
    const account = kind === "rename" ? await store.get(id) : null;
    return prompt(ctx, kind, id, [
      b(t("namePrompt")), account ? b(account.label) : "",
      t(kind === "rename" ? "nameRename" : "nameAdd")
    ].filter(Boolean).join("\n\n"));
  }
  async function promptRemoval(ctx, id) {
    const account = await store.get(id);
    if (account.legacy) return r.replyHtml(ctx, t("defaultProtected"), menuKeyboard());
    return prompt(ctx, "delete", id, `${t("deleteConfirm")}\n\n${b(account.label)}`);
  }
  async function consumeCallbackFlow(ctx, token, kind) {
    const flow = readFlow(ctx);
    if (!flow || flow.token !== token || (kind && flow.kind !== kind)
      || flow.promptId !== ctx.callbackQuery?.message?.message_id || flow.expiresAt <= now()) {
      if (flow?.expiresAt <= now()) await clearFlow(ctx);
      await r.replyHtml(ctx, t("uiExpired"), menuKeyboard());
      return null;
    }
    await clearFlow(ctx);
    return flow;
  }
  function isNamePromptReply(ctx) {
    const reply = ctx.message?.reply_to_message;
    return reply?.from?.id === ctx.botInfo?.id && Boolean(reply?.from?.is_bot)
      && ["en", "ko", "zh-tw"].some((language) => reply.text?.startsWith(accountText(language, "namePrompt")));
  }
  async function handleInput(ctx, next) {
    const flow = readFlow(ctx);
    const text = ctx.message?.text;
    if (text?.trimStart().startsWith("/")) {
      await serialize(ctx, () => clearFlow(ctx));
      return next();
    }
    const promptReply = isNamePromptReply(ctx);
    if (!flow && !promptReply) return next();
    const replyId = ctx.message?.reply_to_message?.message_id;
    if (flow && replyId && replyId !== flow.promptId && !promptReply) {
      await serialize(ctx, () => clearFlow(ctx));
      return next();
    }
    return guard(ctx, async () => {
      const current = readFlow(ctx);
      if (!current || current.expiresAt <= now() || (replyId && replyId !== current.promptId)) {
        if (current?.expiresAt <= now()) await clearFlow(ctx);
        return r.replyHtml(ctx, t("uiExpired"), menuKeyboard());
      }
      if (current.kind === "delete") return r.replyHtml(ctx, t("deleteButtons"));
      let label;
      try { label = cleanLabel(text || ""); } catch {
        return r.replyHtml(ctx, t("nameInvalid"));
      }
      await clearFlow(ctx);
      if (current.kind === "login") return begin(ctx, label);
      await store.rename(current.accountId, label);
      return show(ctx, `${t("nameSaved")} ${b(label)}`);
    });
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
        button(t("check"), `acct:check:${account.id}`)
      ], [
        button(t("rename"), `acct:rename:${account.id}`),
        ...(account.legacy ? [] : [button(t("remove"), `acct:remove:${account.id}`)])
      ]);
    }
    lines.push("", `${t("rotate")}: ${settings.autoRotate ? t("on") : t("off")}`, escapeHtml(t("commands")));
    rows.push([button(t("add"), "acct:login"), button(`${t("rotate")} ${settings.autoRotate ? t("off") : t("on")}`, `acct:rotate:${settings.autoRotate ? "off" : "on"}`)]);
    rows.push([button(t("usageButton"), "acct:usage")]);
    return r.replyHtml(ctx, lines.filter((line) => line !== undefined).join("\n"), keyboard(rows));
  }
  async function showUsage(ctx) {
    const extra = keyboard([
      [button(t("usageRefresh"), "acct:usage")],
      [button(t("menu"), "acct:list"), button(t("main"), "p:main")]
    ]);
    let html;
    try {
      const id = selectedAccountId(r.getChatState(r.getChatKey(ctx)));
      const account = await store.get(id);
      if (account.status === "pending") {
        html = `${b(t("usageTitle"))}\n\n${b(account.label)}\n${t("usagePending")}`;
      } else {
        const release = await store.acquire(id, { allowUnavailable: true });
        try {
          const usage = await readUsage(r.config, id);
          html = formatAccountUsageHtml(usage, { label: account.label, text: t, formatDateTime: r.formatDateTime });
        } finally { await release(); }
      }
    } catch {
      html = `${b(t("usageTitle"))}\n\n${t("usageFailed")}`;
    }
    return ctx.callbackQuery ? r.editOrReplyHtml(ctx, html, extra) : r.replyHtml(ctx, html, extra);
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
              { ...inlineKeyboard([[{ text: "🔐 ChatGPT", url: verificationUrl }, button(t("cancel"), "acct:cancel")]]), protect_content: true, link_preview_options: { is_disabled: true } });
          }
        });
        await r.replyHtml(ctx, `${t("done")}\n${b(account.label)}`,
          keyboard([[button(`${t("use")} · ${account.label}`, `acct:use:${account.id}`)], [button(t("menu"), "acct:list")]]));
      } catch (error) {
        await r.replyHtml(ctx, abort.signal.aborted ? t("cancelled") : `${t("failed")}\n${code(r.redactText?.(error.message) || error.message)}`).catch(() => {});
      } finally {
        if (session.codeMessage?.message_id) await r.bot.telegram.deleteMessage(ctx.chat.id, session.codeMessage.message_id).catch(() => {});
        pending.delete(key);
      }
    })();
  }
  async function action(ctx, operation, id, value) {
    if (operation === "usage") return showUsage(ctx);
    if (operation === "use") return use(ctx, id);
    if (operation === "rename") {
      if (value === undefined) return promptName(ctx, "rename", id);
      const renamed = await store.rename(id, value);
      return show(ctx, `${t("nameSaved")} ${b(renamed.label)}`);
    }
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
    if (operation === "remove" || operation === "delete") return promptRemoval(ctx, id);
    if (operation === "confirm") {
      const flow = await consumeCallbackFlow(ctx, id, "delete");
      if (!flow) return;
      const accountId = flow.accountId;
      const account = await store.get(accountId);
      if (account.status === "pending" && pending.size) throw new Error("Sign-in is still pending. Use /reauth cancel first.");
      await store.remove(accountId);
      for (const [key, chat] of Object.entries(r.state.chats || {})) {
        if (chat.accountId === accountId) chat.accountId = "default";
        if (chat.threadAccountId === accountId) { delete chat.threadId; delete chat.threadAccountId; }
        if (chat.accountThreads) delete chat.accountThreads[accountId];
        r.threadCache.delete(key);
      }
      await r.saveState();
      return show(ctx, `${t("deleted")} ${b(account.label)}`);
    }
    if (operation === "cancelui") {
      if (!await consumeCallbackFlow(ctx, id)) return;
      return show(ctx, t("uiCancelled"));
    }
    if (operation === "login") return promptName(ctx, "login");
    if (operation === "cancel") { pending.get(String(ctx.from.id))?.abort.abort(); return; }
    return show(ctx);
  }
  r.bot.command("accounts", (ctx) => guard(ctx, async () => {
    await clearFlow(ctx);
    const [operation, id, ...rest] = r.getCommandArgs(ctx).trim().split(/\s+/);
    return action(ctx, operation, id, rest.join(" "));
  }));
  r.bot.command("reauth", (ctx) => guard(ctx, async () => {
    await clearFlow(ctx);
    const label = r.getCommandArgs(ctx).trim();
    return label === "cancel" ? action(ctx, "cancel") : begin(ctx, label);
  }));
  r.bot.command("usage", (ctx) => guard(ctx, async () => {
    await clearFlow(ctx);
    return showUsage(ctx);
  }));
  r.bot.action(/^acct:([a-z]+)(?::([a-z0-9-]+))?$/, (ctx) => guard(ctx, async () => {
    if (!["confirm", "cancelui"].includes(ctx.match[1])) await clearFlow(ctx);
    return action(ctx, ctx.match[1], ctx.match[2]);
  }));
  r.bot.on("callback_query", async (ctx, next) => {
    await serialize(ctx, () => clearFlow(ctx));
    return next();
  });
  r.bot.on("message", handleInput);
  return { pending, show, close: () => { for (const session of pending.values()) session.abort.abort(); } };
}
