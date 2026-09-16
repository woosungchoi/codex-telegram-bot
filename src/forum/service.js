import { LocalizedError } from "../i18n.js";
import path from "node:path";
import { authorizeTelegramUpdate } from "../security.js";
import { directory, newId, projectOptions } from "../workspace/store.js";
import { applyTopicBinding, forumChatType, forumDestination, forumGroup, forumProjects, forumRootTopicId, forumState, forumTopicId, forumTopicKey } from "./store.js";

export function createForumService(r, { accounts, now = Date.now, text: t }) {
  const state = forumState(r.state), locks = new Map();
  function group(ctx) {
    const value = forumGroup(r.state, ctx, r.bot.botInfo?.id);
    if (!value) throw new Error(t("forumOnly"));
    authorize(ctx.from.id, value, forumTopicId(ctx));
    return value;
  }
  function authorize(userId, value, id) {
    const chatType = forumChatType(value);
    if (chatType === "private" && (String(userId) !== String(value.chatId) || String(userId) !== String(value.ownerId))) {
      throw new LocalizedError("errors.thisPrivateChatBelongsToAnotherUser");
    }
    if (value.botId !== r.bot.botInfo?.id || !authorizeTelegramUpdate({
      from: { id: userId }, chat: { id: value.chatId, type: chatType, is_forum: chatType === "supergroup" },
      message: { message_thread_id: forumDestination(value, id).messageThreadId }
    }, r.config).ok) throw new LocalizedError("errors.theUserBotOrTopicIsNoLongerAuthorized");
  }
  async function exclusive(value, fn) {
    const key = String(value.chatId);
    const work = (locks.get(key) || Promise.resolve()).catch(() => {}).then(fn);
    locks.set(key, work);
    try { return await work; } finally { if (locks.get(key) === work) locks.delete(key); }
  }
  function topic(value, id) {
    const item = value.topics[id];
    if (!item) throw new LocalizedError("errors.thisTopicIsNoLongerRegisteredOpenTopicsAgain");
    return item;
  }
  function assertIdle(value, id) {
    const key = forumTopicKey(value, id);
    if (r.activeTurns.has(key) || r.getSideTurnCount(key) || r.getPendingTurns(key).length || r.hasPendingFinalDelivery(key)) throw new Error(t("busy"));
  }
  async function rights(value) {
    if (forumChatType(value) === "private") {
      // Refresh after BotFather changes without requiring a bot restart.
      const me = await r.bot.telegram.getMe();
      if (me.id !== value.botId || me.has_topics_enabled !== true) throw new Error(t("privateSetupHint"));
      r.bot.botInfo = me;
      return;
    }
    const member = await r.bot.telegram.getChatMember(value.chatId, value.botId);
    if (member.status !== "creator" && !(member.status === "administrator" && member.can_manage_topics)) throw new Error(t("setupHint"));
  }
  function preset(ctx, cwd) {
    const options = r.getEffectiveOptions(r.getChatKey(ctx));
    return { accountId: r.getChatState(r.getChatKey(ctx)).accountId || "default", options: { ...projectOptions(options), workingDirectory: cwd }, cwd };
  }
  async function resolve(ctx, input) {
    const candidates = forumProjects(r.state, ctx.from.id).filter((p) => p.name.toLocaleLowerCase() === input.toLocaleLowerCase());
    if (candidates.length > 1 && new Set(candidates.map((p) => p.cwd)).size > 1) throw new LocalizedError("errors.moreThanOneProjectHasThisNameChooseIts");
    const selected = candidates[0];
    const cwd = await directory(selected?.cwd || input);
    return selected ? { ...selected, cwd } : { ...preset(ctx, cwd), name: path.basename(cwd) || "Project" };
  }
  async function validatePreset(value, id, selected) {
    const cwd = await directory(selected.cwd);
    if (Object.values(value.topics).some((item) => item.role === "project" && item.id !== id && item.cwd === cwd)) {
      throw new LocalizedError("errors.thisFolderIsAlreadyConnectedToAnotherTopicIn");
    }
    const account = await accounts.get(selected.accountId || "default");
    if (account.status !== "ready") throw new LocalizedError("errors.theProjectAccountNeedsSignInUseAccountsIn");
    return { ...selected, cwd, accountId: account.id, options: { ...projectOptions(selected.options || {}), workingDirectory: cwd } };
  }
  async function setup(ctx) {
    const chatType = ctx.chat?.type;
    if (!["private", "supergroup"].includes(chatType)) throw new Error(t("setupHint"));
    if (chatType === "supergroup") {
      const probe = await r.bot.telegram.getChat(ctx.chat.id);
      if (!probe.is_forum) throw new Error(t("setupHint"));
    }
    const old = state.groups[String(ctx.chat.id)];
    if (old && old.botId !== r.bot.botInfo.id) throw new LocalizedError("errors.thisGroupBelongsToAnotherBotIdentityInSaved");
    if (old && forumChatType(old) !== chatType) throw new LocalizedError("errors.theSavedChatTypeDoesNotMatch");
    const value = old || { chatId: ctx.chat.id, chatType, botId: r.bot.botInfo.id, ownerId: ctx.from.id, topics: {}, createdAt: now() };
    authorize(ctx.from.id, value, forumTopicId(ctx));
    return exclusive(value, async () => {
      // Another setup request may have completed while this one was waiting.
      const saved = state.groups[String(value.chatId)] || value;
      await rights(saved);
      const root = forumRootTopicId(saved);
      if (!saved.topics[root]) saved.topics[root] = { id: root,
        name: chatType === "private" ? t("privateConversation") : "General", role: chatType === "private" ? "workspace" : "manager" };
      // Keep an existing private conversation usable without rebinding its session.
      const current = forumTopicId(ctx);
      if (chatType === "private" && current && !saved.topics[current]) {
        saved.topics[current] = { id: current, name: t("privateConversation"), role: "workspace" };
      }
      state.groups[String(saved.chatId)] = saved;
      await r.saveState();
      if (chatType === "supergroup" && !saved.aiTopicId && !r.config.allowedThreadIds?.size) {
        const cwd = await directory(r.getEffectiveOptions(r.getChatKey(ctx)).workingDirectory);
        const created = await r.bot.telegram.createForumTopic(saved.chatId, "AI Chat");
        saved.aiTopicId = created.message_thread_id;
        saved.topics[saved.aiTopicId] = { id: saved.aiTopicId, name: created.name || "AI Chat", role: "workspace",
          cwd, preset: preset(ctx, cwd), bindingId: newId() };
        applyTopicBinding(r, saved, saved.topics[saved.aiTopicId]);
        await r.saveState();
      }
      return saved;
    });
  }
  async function bind(ctx, id, selected) {
    const value = group(ctx);
    return exclusive(value, async () => {
      authorize(ctx.from.id, value, id);
      const item = topic(value, id);
      if (item.role !== "project") throw new LocalizedError("errors.generalAndAIChatCannotBeBoundToA");
      assertIdle(value, id);
      const checked = await validatePreset(value, id, selected);
      assertIdle(value, id);
      Object.assign(item, { cwd: checked.cwd, preset: checked, bindingId: newId() });
      applyTopicBinding(r, value, item);
      await r.saveState();
      return item;
    });
  }
  async function create(ctx, name, selected) {
    const value = group(ctx);
    return exclusive(value, async () => {
      if (r.config.allowedThreadIds?.size) throw new LocalizedError("errors.allowedThreadsRestrictNewTopics");
      const title = String(name || "").trim();
      if (!title || title.length > 128 || /\p{Cc}/u.test(title)) throw new LocalizedError("errors.useATopicNameOf1128Characters");
      if (Object.values(value.topics).some((item) => item.name.toLocaleLowerCase() === title.toLocaleLowerCase())) throw new LocalizedError("errors.thisTopicNameIsAlreadyInUse");
      if (Object.values(value.topics).filter((item) => item.role === "project").length >= 60) throw new LocalizedError("errors.atMost60ProjectTopicsPerChat");
      const checked = await validatePreset(value, null, selected);
      await rights(value);
      const created = await r.bot.telegram.createForumTopic(value.chatId, title);
      const item = { id: created.message_thread_id, name: title, role: "project", cwd: checked.cwd, preset: checked, bindingId: newId() };
      value.topics[item.id] = item;
      applyTopicBinding(r, value, item);
      await r.saveState();
      return item;
    });
  }
  async function update(ctx, id, action) {
    const value = group(ctx);
    return exclusive(value, async () => {
      authorize(ctx.from.id, value, id);
      const item = topic(value, id);
      if (item.role !== "project") throw new LocalizedError("errors.onlyProjectTopicsSupportThisAction");
      assertIdle(value, id);
      if (action === "unbind") {
        const key = forumTopicKey(value, id), chat = r.getChatState(key);
        delete item.cwd; delete item.preset; delete item.bindingId;
        delete chat.forumBinding;
        for (const name of ["threadId", "threadAccountId", "accountThreads", "accountAttemptState"]) delete chat[name];
        r.threadCache.delete(key);
      } else {
        await rights(value); assertIdle(value, id);
        // Telegram close/reopen methods only support supergroups. Private topics
        // use a reversible pause of bot work, without deleting chat history.
        if (forumChatType(value) === "supergroup") {
          if (action === "close") await r.bot.telegram.closeForumTopic(value.chatId, id);
          else await r.bot.telegram.reopenForumTopic(value.chatId, id);
        }
        item.closed = action === "close";
      }
      await r.saveState();
      return item;
    });
  }
  return { state, group, topic, authorize, exclusive, assertIdle, resolve, preset, setup, bind, create, update,
    destination: forumDestination, key: forumTopicKey };
}
