import { b, code } from "../telegram/html.js";
import { newId, scopeKey, topicId, workspaceState } from "./store.js";
import { isRegisteredTelegramCommandText } from "../telegram_commands.js";
import { isTelegramServiceMessage } from "../telegram/service_messages.js";
import { menuButtonText } from "../ui/button_labels.js";
import { completeMenuRows, WORKSPACE_INPUT_PARENTS } from "../ui/menu_definition.js";
import { createNavigationKeyboardViews } from "../ui/keyboard_helpers.js";

export function createWorkspaceUi(r, t, { now = Date.now } = {}) {
  const state = workspaceState(r.state);
  const locks = new Map();
  const navigation = createNavigationKeyboardViews({ text: (key) => key === "back" ? t(key).replace(/^(?:←|⬅️)\s*/u, "") : t(key) });
  const button = (label, type, args = {}) => ({ label, action: { type, ...args } });
  const back = (type, args = {}) => ({ ...button(t("back"), type, args), role: "back" });
  // Prefixing an emoji can shift the cutoff into an existing surrogate pair.
  const buttonText = (label, action) => menuButtonText(label, action).slice(0, 64).replace(/[\uD800-\uDBFF]$/u, "");
  async function clear(ctx) { delete state.flows[scopeKey(ctx)]; await r.saveState(); }
  async function show(ctx, html, rows = [], data = {}) {
    const token = newId();
    const actions = [];
    const parentPanel = ctx.state.workspaceParentPanel === "tools" ? "tools" : "main";
    const framed = completeMenuRows(rows, {
      back: back("home", { panel: parentPanel }),
      close: { ...button(t("close"), "close"), role: "close" }
    });
    const markup = { inline_keyboard: framed.map((row) => row.map((item) => {
      if (item.url) return { text: buttonText(item.label, "web"), url: item.url };
      const index = actions.push(item.action) - 1;
      return { text: buttonText(item.label, item.action.type), callback_data: `ws:${token}:${index}` };
    })) };
    const extra = { reply_markup: markup };
    const message = ctx.callbackQuery ? await r.editOrReplyHtml(ctx, html, extra) : await r.replyHtml(ctx, html, extra);
    state.flows[scopeKey(ctx)] = { token, botId: r.bot.botInfo.id, messageId: message?.message_id || ctx.callbackQuery?.message?.message_id,
      chatId: ctx.chat.id, messageThreadId: topicId(ctx), userId: ctx.from.id,
      expiresAt: now() + 15 * 60_000, actions, markup, html, data, parentPanel };
    await r.saveState();
    return state.flows[scopeKey(ctx)];
  }
  async function ask(ctx, label, data, hint = "") {
    const parent = WORKSPACE_INPUT_PARENTS[data.stage?.split("-")[0]] || "home";
    return show(ctx, `${b(t("input"))}\n\n${b(label)}\n${hint}\n\n${t("inputHint")}`,
      [[button(t("cancel"), parent)], [back(parent, data.view)]], { ...data, awaiting: true });
  }
  async function close(ctx) {
    await clear(ctx);
    if (ctx.callbackQuery) await r.editOrReplyHtml(ctx, b(t("close")), { reply_markup: { inline_keyboard: [] } });
    else await r.replyHtml(ctx, b(t("cancel")));
  }
  async function guard(ctx, fn, validate) {
    const answer = async (text) => {
      if (ctx.callbackQuery) await (text === undefined ? ctx.answerCbQuery() : ctx.answerCbQuery(text)).catch(() => {});
    };
    if (!validate) await answer();
    const key = scopeKey(ctx);
    const promise = (locks.get(key) || Promise.resolve()).catch(() => {}).then(async () => {
      if (validate) {
        try { validate(); } catch { await answer(t("expired")); return; }
        await answer();
      }
      return fn();
    });
    locks.set(key, promise);
    try { return await promise; } catch (error) {
      const html = `${b(t("error"))}\n${code(String(r.redactText?.(error.message) || error.message).slice(0, 1600))}`;
      const flow = state.flows[key];
      const extra = ctx.callbackQuery && flow?.messageId === ctx.callbackQuery.message?.message_id && flow.expiresAt > now()
        ? { reply_markup: flow.markup }
        : navigation.withMenuCloseButton(navigation.withPreviousPanelButton(undefined, ctx.state.workspaceParentPanel === "tools" ? "tools" : "main"));
      if (ctx.callbackQuery) await r.editOrReplyHtml(ctx, html, extra);
      else await r.replyHtml(ctx, html, extra);
    } finally { if (locks.get(key) === promise) locks.delete(key); }
  }
  function read(ctx, token) {
    const flow = state.flows[scopeKey(ctx)];
    if (!flow || flow.botId !== r.bot.botInfo.id || flow.expiresAt <= now() || (token && (token !== flow.token || flow.messageId !== ctx.callbackQuery?.message?.message_id))) {
      throw new Error(t("expired"));
    }
    return flow;
  }
  function register(onAction, onInput) {
    r.bot.action(/^ws:([a-f0-9]{16}):(\d+)$/, (ctx) => guard(ctx, async () => {
      const flow = read(ctx, ctx.match[1]);
      const action = flow.actions[Number(ctx.match[2])];
      if (!action) throw new Error(t("expired"));
      ctx.state.workspaceParentPanel = flow.parentPanel;
      return onAction(ctx, action, flow.data);
    }, () => read(ctx, ctx.match[1])));
    r.bot.on("callback_query", async (ctx, next) => { await clear(ctx); return next(); });
    r.bot.on("message", async (ctx, next) => {
      if (isTelegramServiceMessage(ctx.message)) return next();
      const value = ctx.message?.text?.trim();
      if (isRegisteredTelegramCommandText(ctx.message)) { await clear(ctx); return next(); }
      const flow = state.flows[scopeKey(ctx)];
      const reply = ctx.message?.reply_to_message;
      const staleReply = reply?.from?.id === r.bot.botInfo?.id && reply?.text?.startsWith("✍️");
      if (!flow?.data.awaiting && !staleReply) return next();
      return guard(ctx, async () => {
        const current = read(ctx);
        if (reply && reply.message_id !== current.messageId) throw new Error(t("expired"));
        if (!current.data.awaiting || !value) throw new Error(t("useButtons"));
        ctx.state.workspaceParentPanel = current.parentPanel;
        return onInput(ctx, value, current.data);
      });
    });
  }
  return { button, back, clear, show, ask, close, guard, read, register };
}
