import { randomBytes } from "node:crypto";
import { createAccountStore, cleanLabel } from "./store.js";
import { selectedAccountId } from "./context.js";
import { signInAccount, inspectAccount } from "./auth.js";
import { accountText } from "./messages.js";
import { createAccountUsageReader, formatAccountUsageHtml, readAccountUsage } from "./usage.js";
import { consumeAccountResetCredit } from "./reset_credits.js";
import { createResetCreditsController } from "./reset_controller.js";
import { b, code, escapeHtml } from "../telegram/html.js";
import { inlineKeyboard } from "../ui/keyboard_helpers.js";
import { renderMenu } from "../ui/menu_definition.js";
import { telegramChatKey } from "../telegram/context.js";
import { isTelegramServiceMessage } from "../telegram/service_messages.js";

export function registerAccountCommands(r, { store = createAccountStore(r.config), signIn = signInAccount, inspect = inspectAccount, readUsage = readAccountUsage, consumeCredit = consumeAccountResetCredit, now = Date.now } = {}) {
  const usageReader = createAccountUsageReader(r.config, { read: readUsage, now });
  const pending = new Map();
  const operations = new Map();
  const t = (key) => accountText(r.state.ui?.language || r.config.telegramLanguage, key);
  const keyboard = (rows, previous = "acct:list") => renderMenu(inlineKeyboard(rows), { text: t, previous, close: true });
  const button = (text, data) => ({ text, callback_data: data });
  const flowKey = (ctx) => `${telegramChatKey(ctx)}:${ctx.from?.id}`;
  const readFlow = (ctx) => r.state.accountUi?.[flowKey(ctx)];
  const menuKeyboard = () => keyboard([[button(t("menu"), "acct:list")]]);
  const resets = createResetCreditsController(r, {
    store, readUsage: (_config, id) => usageReader.read(id, { fresh: true }),
    consumeCredit: async (...args) => {
      usageReader.invalidate();
      try { return await consumeCredit(...args); } finally { usageReader.invalidate(); }
    }, showUsage, replyMenu, text: t, keyboard, button, flowKey, readFlow, clearFlow, now
  });
  async function replyMenu(ctx, html, extra) {
    if (!ctx.callbackQuery) return r.replyHtml(ctx, html, extra);
    const message = await r.editOrReplyHtml(ctx, html, extra);
    return message?.message_id ? message : ctx.callbackQuery.message;
  }
  async function serialize(ctx, action) {
    const key = flowKey(ctx);
    const operation = (operations.get(key) || Promise.resolve()).catch(() => {}).then(action);
    operations.set(key, operation);
    try { return await operation; } finally {
      if (operations.get(key) === operation) operations.delete(key);
    }
  }
  async function guard(ctx, action, callbackFlow) {
    let answered = false;
    const answer = async (text) => {
      if (!ctx.callbackQuery || answered) return;
      answered = true;
      await (text === undefined ? ctx.answerCbQuery() : ctx.answerCbQuery(text)).catch(() => {});
    };
    if (ctx.chat?.type !== "private" || !r.config.allowedUserIds.has(String(ctx.from?.id))
      || !r.config.codexAccountAdminUserIds.has(String(ctx.from?.id))) {
      if (ctx.callbackQuery) return answer(t("private"));
      return replyMenu(ctx, t("private"), keyboard([], "p:main"));
    }
    if (!callbackFlow) await answer();
    try { return await serialize(ctx, async () => {
      if (callbackFlow) {
        // Validate after earlier clicks finish; stale tokens must not replace a newer panel or result.
        const flow = readFlow(ctx);
        if (!flow || flow.token !== callbackFlow.token || (callbackFlow.kind && flow.kind !== callbackFlow.kind)
          || flow.promptId !== ctx.callbackQuery.message?.message_id || flow.expiresAt <= now()) {
          if (flow?.expiresAt <= now()) await clearFlow(ctx);
          await answer(t("uiExpired"));
          return;
        }
        await answer();
      }
      return action();
    }); } catch (error) {
      await answer();
      return replyMenu(ctx, `${t("failed")}\n${code(r.redactText?.(error.message) || error.message)}`, menuKeyboard());
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
    const message = await replyMenu(ctx, html, keyboard(rows));
    r.state.accountUi ||= {};
    r.state.accountUi[flowKey(ctx)] = {
      kind, accountId, token, promptId: message.message_id, expiresAt: now() + 5 * 60_000
    };
    await r.saveState();
  }
  async function promptName(ctx, kind, id) {
    if (kind === "login" && pending.has(String(ctx.from.id))) return replyMenu(ctx, t("busy"), menuKeyboard());
    const account = kind === "rename" ? await store.get(id) : null;
    return prompt(ctx, kind, id, [
      b(t("namePrompt")), account ? b(account.label) : "",
      t(kind === "rename" ? "nameRename" : "nameAdd")
    ].filter(Boolean).join("\n\n"));
  }
  async function promptRemoval(ctx, id) {
    const account = await store.get(id);
    if (account.legacy) return replyMenu(ctx, t("defaultProtected"), menuKeyboard());
    return prompt(ctx, "delete", id, `${t("deleteConfirm")}\n\n${b(account.label)}`);
  }
  async function consumeCallbackFlow(ctx, token, kind) {
    const flow = readFlow(ctx);
    if (!flow || flow.token !== token || (kind && flow.kind !== kind)
      || flow.promptId !== ctx.callbackQuery?.message?.message_id || flow.expiresAt <= now()) {
      if (flow?.expiresAt <= now()) await clearFlow(ctx);
      await replyMenu(ctx, t("uiExpired"), menuKeyboard());
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
    if (isTelegramServiceMessage(ctx.message)) return next();
    const flow = readFlow(ctx);
    const text = ctx.message?.text;
    if (text?.trimStart().startsWith("/")) {
      await serialize(ctx, () => clearFlow(ctx));
      return next();
    }
    const promptReply = isNamePromptReply(ctx);
    if (!flow && !promptReply) return next();
    const replyId = ctx.message?.reply_to_message?.message_id;
    const replyToken = ctx.message?.reply_to_message?.reply_markup?.inline_keyboard?.flat()
      .find((button) => button.callback_data?.startsWith("acct:cancelui:"))?.callback_data.slice("acct:cancelui:".length);
    if (flow && replyId && replyId !== flow.promptId && !promptReply) {
      await serialize(ctx, () => clearFlow(ctx));
      return next();
    }
    return guard(ctx, async () => {
      const current = readFlow(ctx);
      if (!current || current.expiresAt <= now() || (replyId && replyId !== current.promptId)
        || (replyToken && replyToken !== current.token)) {
        if (current?.expiresAt <= now()) await clearFlow(ctx);
        return r.replyHtml(ctx, t("uiExpired"), menuKeyboard());
      }
      if (!["login", "rename"].includes(current.kind)) return r.replyHtml(ctx, t(current.kind === "delete" ? "deleteButtons" : "resetButtons"), menuKeyboard());
      let label;
      try { label = cleanLabel(text || ""); } catch {
        return r.replyHtml(ctx, t("nameInvalid"), menuKeyboard());
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
    rows.push([button(t("usageButton"), `acct:usage:${selected}:accounts`), button(t("resetButton"), "acct:reset")]);
    return replyMenu(ctx, lines.filter((line) => line !== undefined).join("\n"), keyboard(rows, "p:main"));
  }
  async function showUsage(ctx, requestedId, notice = "", parent = "main", fresh = false) {
    const id = requestedId || selectedAccountId(r.getChatState(r.getChatKey(ctx)));
    const usageCallback = (accountId) => `acct:usage:${accountId}${parent === "accounts" ? ":accounts" : ""}`;
    const rows = [
      [button(t("usageRefresh"), usageCallback(id).replace("acct:usage:", "acct:usagerefresh:"))],
      [button(t("resetButton"), `acct:reset:${id}`)],
      [button(t("menu"), "acct:list"), button(t("main"), "p:main")]
    ];
    let html, account;
    try {
      const accounts = await store.list();
      rows.splice(1, 0, ...accounts.map((item) => [
        button(`${item.id === id ? "✅ " : ""}${item.label}`, usageCallback(item.id))
      ]));
      account = accounts.find((item) => item.id === id);
      if (!account) {
        html = `${b(t("usageTitle"))}\n\n${t("usageAccountMissing")}`;
      } else if (account.status === "pending") {
        html = `${b(t("usageTitle"))}\n\n${b(account.label)}\n${t("usagePending")}`;
      } else {
        const release = await store.acquire(id, { allowUnavailable: true });
        try {
          const usage = await usageReader.read(id, { fresh });
          html = formatAccountUsageHtml(usage, { label: account.label, text: t, formatDateTime: r.formatDateTime });
        } finally { await release(); }
      }
    } catch {
      html = [b(t("usageTitle")), account ? b(account.label) : "", t("usageFailed")].filter(Boolean).join("\n\n");
    }
    if (notice) html = `${notice}\n\n${html}`;
    html += `\n\n${t("usageBrowseHint")}`;
    const extra = keyboard(rows, parent === "accounts" ? "acct:list" : "p:main");
    return replyMenu(ctx, html, extra);
  }
  async function use(ctx, id) {
    const account = await store.get(id);
    if (account.status !== "ready") throw new Error("This account needs sign-in. Use /reauth.");
    const chatKey = r.getChatKey(ctx);
    usageReader.invalidate();
    r.getChatState(chatKey).accountId = id;
    r.threadCache.delete(chatKey);
    await r.saveState();
    return show(ctx, t("next"));
  }
  async function begin(ctx, label) {
    const key = String(ctx.from.id);
    if (pending.has(key)) return r.replyHtml(ctx, t("busy"), menuKeyboard());
    const abort = new AbortController();
    const session = { abort, codeMessage: null };
    pending.set(key, session);
    try { await r.replyHtml(ctx, t("start"), menuKeyboard()); } catch (error) { pending.delete(key); throw error; }
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
        usageReader.invalidate();
        await r.replyHtml(ctx, `${t("done")}\n${b(account.label)}`,
          keyboard([[button(`${t("use")} · ${account.label}`, `acct:use:${account.id}`)], [button(t("menu"), "acct:list")]]));
      } catch (error) {
        await r.replyHtml(ctx, abort.signal.aborted ? t("cancelled") : `${t("failed")}\n${code(r.redactText?.(error.message) || error.message)}`, menuKeyboard()).catch(() => {});
      } finally {
        if (session.codeMessage?.message_id) await r.bot.telegram.deleteMessage(ctx.chat.id, session.codeMessage.message_id).catch(() => {});
        pending.delete(key);
      }
    })();
  }
  async function action(ctx, operation, id, value) {
    if (operation === "reset") return resets.show(ctx, id);
    if (operation === "resetpick") return resets.pick(ctx, id);
    if (operation === "resetpage") return resets.page(ctx, id);
    if (operation === "resetconfirm") return resets.confirm(ctx, id);
    if (operation === "usage") return showUsage(ctx, id);
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
      usageReader.invalidate();
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
      usageReader.invalidate();
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
      const flow = await consumeCallbackFlow(ctx, id);
      if (!flow) return;
      return show(ctx, t(flow.kind === "reset-confirm" && flow.retry ? "resetPendingNotice" : "uiCancelled"));
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
  r.bot.action(/^acct:([a-z]+)(?::([a-z0-9-]+))?(?::(accounts))?$/, (ctx) => {
    const kinds = { confirm: "delete", cancelui: null, resetpick: "reset-list", resetpage: "reset-list", resetconfirm: "reset-confirm" };
    const callbackFlow = Object.hasOwn(kinds, ctx.match[1])
      ? { kind: kinds[ctx.match[1]], token: ctx.match[2]?.split("-")[0] } : null;
    return guard(ctx, async () => {
      if (!callbackFlow) await clearFlow(ctx);
      if (["usage", "usagerefresh"].includes(ctx.match[1])) return showUsage(ctx, ctx.match[2], "", ctx.match[3], ctx.match[1] === "usagerefresh");
      return action(ctx, ctx.match[1], ctx.match[2]);
    }, callbackFlow);
  });
  r.bot.on("callback_query", async (ctx, next) => {
    await serialize(ctx, () => clearFlow(ctx));
    return next();
  });
  r.bot.on("message", handleInput);
  return { pending, show, close: () => { for (const session of pending.values()) session.abort.abort(); } };
}
