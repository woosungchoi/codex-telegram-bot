import { Telegraf } from "telegraf";
import { registerWorkspaceFlowBoundary, registerWorkspaceMenus } from "../../src/workspace/controller.js";
import { editOrReplyTelegramHtml } from "../../src/telegram/api.js";
import { accountFixture } from "./accounts_fixture.mjs";
import { telegramChatKey } from "../../src/telegram/context.js";
import { registerForumContext } from "../../src/forum/store.js";

export async function workspaceFixture(t, options = {}) {
  const storage = await accountFixture(t);
  const bot = new Telegraf("123:test");
  bot.botInfo = { id: 123, is_bot: true, first_name: "Bot", username: "test_bot" };
  const messages = [], apiCalls = [], forwarded = [], starts = [], backendCalls = [], saves = [];
  let seq = 100, mcpEnabled = true;
  const clock = { now: Date.parse("2026-09-12T00:00:00Z") };
  const api = async (method, payload) => {
    apiCalls.push({ method, payload });
    if (options.api) {
      const result = await options.api(method, payload);
      if (result !== undefined) return result;
    }
    if (method === "editMessageText") {
      const msg = messages.find((m) => m.message_id === payload.message_id);
      if (msg) Object.assign(msg, { html: payload.text, text: payload.text.replace(/<[^>]*>/g, ""), extra: { reply_markup: payload.reply_markup } });
      return msg || true;
    }
    return true;
  };
  bot.telegram.callApi = api;
  bot.use((ctx, next) => { ctx.telegram.callApi = api; return next(); });
  bot.catch((e) => { throw e; });
  const state = options.state || { ui: { language: "ko", timeZone: "Asia/Seoul" }, chats: {} };
  const queue = new Map();
  const r = {
    bot, state, config: { ...storage.config, codexWorkdir: storage.root, allowedUserIds: new Set(["1", "2"]),
      codexAccountAdminUserIds: new Set(["1"]), telegramLanguage: "ko", telegramTimeZone: "Asia/Seoul" },
    threadCache: new Map(), activeTurns: new Map(), getChatKey: telegramChatKey,
    getChatState: (key) => state.chats[key] ||= { options: {}, accountId: "default", threadId: "original" },
    getEffectiveOptions: (key) => ({ workingDirectory: storage.root, model: "model-one", sandboxMode: "read-only", ...r.getChatState(key).options }),
    getPendingTurns: (key) => queue.get(key) || [], getSideTurnCount: () => 0, hasPendingFinalDelivery: () => false,
    isQueuePaused: () => false, redactText: (v) => v.replaceAll("SECRET", "[redacted]"),
    formatDateTime: (at) => new Date(at).toISOString(),
    getCommandArgs: (ctx) => ctx.message.text.replace(/^\S+\s*/, ""),
    saveState: async () => { saves.push(JSON.parse(JSON.stringify(state))); },
    replyHtml: async (ctx, html, extra) => {
      const msg = { message_id: ++seq, from: bot.botInfo, chat: ctx.chat,
        message_thread_id: ctx.message?.message_thread_id || ctx.callbackQuery?.message?.message_thread_id,
        html, text: html.replace(/<[^>]*>/g, ""), extra };
      messages.push(msg); return msg;
    },
    editOrReplyHtml: editOrReplyTelegramHtml,
    sendPanel: (ctx) => r.replyHtml(ctx, "Main menu"), applyPersonaPrompt: (v) => `persona\n${v}`,
    enqueuePendingTurn: async (key, prepared) => {
      queue.set(key, [...(queue.get(key) || []), prepared]); state.queues ||= {}; state.queues[key] = queue.get(key);
      await r.saveState(); return { ok: true, position: 1 };
    },
    clearPendingTurns: async (key) => { queue.delete(key); if (state.queues) delete state.queues[key]; await r.saveState(); },
    startQueueDrainIfIdle: async (key, ctx) => { starts.push({ key, ctx }); return true; },
    createSyntheticCtx: (meta) => ({ chat: { id: meta.chatId, type: meta.chatType },
      message: { message_thread_id: meta.messageThreadId }, telegram: bot.telegram }),
    cancelWorkerJobOnce: async () => {}
  };
  const sessions = [{ id: "session-one", cwd: storage.root, name: "First session", preview: "hello", path: null, updatedAt: clock.now / 1000, status: { type: "idle" } }];
  const backend = options.backend || {
    listSessions: async (id, args) => { backendCalls.push({ method: "listSessions", id, args }); return { data: sessions, nextCursor: args.cursor ? null : "page2" }; },
    readSession: async (id, sessionId) => { backendCalls.push({ method: "readSession", id, sessionId }); return sessions[0]; },
    readMcp: async (id, cwd, health) => { backendCalls.push({ method: "readMcp", id, cwd, health });
      return { rows: [{ name: "test-server", enabled: mcpEnabled, status: health ? "connected" : "notStarted" }], version: "v1" }; },
    setMcpEnabled: async (...args) => { backendCalls.push({ method: "setMcpEnabled", args }); mcpEnabled = args[3]; }
  };
  options.configure?.(r);
  registerForumContext(r);
  registerWorkspaceFlowBoundary(r);
  bot.command("accounts", (ctx) => r.replyHtml(ctx, "Account menu"));
  const controller = registerWorkspaceMenus(r, { accounts: storage.store, backend, now: () => clock.now,
    readTail: options.readTail || (async () => ({ messages: [{ role: "assistant", text: "preview answer" }], activity: "idle" })) });
  t.after(() => controller.stop());
  bot.on("message", (ctx) => forwarded.push(ctx.message.text));
  const user = (id) => ({ id, first_name: "Test", is_bot: false });
  const send = (text, { userId = 1, chatId = 1, threadId, replyTo, chatType = "private", isForum, service } = {}) => bot.handleUpdate({ update_id: ++seq,
    message: { message_id: ++seq, from: user(userId), chat: { id: chatId, type: chatType, is_forum: isForum }, date: 0,
      ...service,
      text, message_thread_id: threadId, ...(replyTo ? { reply_to_message: replyTo } : {}),
      ...(text.startsWith("/") ? { entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0].length }] } : {}) } });
  const click = (data, message = messages.at(-1), { userId = 1, threadId } = {}) => bot.handleUpdate({ update_id: ++seq,
    callback_query: { id: String(++seq), from: user(userId), data,
      message: { ...message, ...(threadId != null ? { message_thread_id: threadId } : {}) }, chat_instance: "test" } });
  const buttons = (msg = messages.at(-1)) => msg?.extra?.reply_markup?.inline_keyboard?.flat() || [];
  const press = async (label) => {
    const button = buttons().find((b) => b.text === label || b.text.includes(label));
    if (!button) throw new Error(`Missing button: ${label}; got ${buttons().map((b) => b.text).join(", ")}; ${messages.at(-1)?.text}`);
    return click(button.callback_data);
  };
  return { ...storage, bot, state, r, controller, messages, apiCalls, forwarded, starts, backendCalls, saves, clock, send, click, press, buttons, queue, sessions };
}
