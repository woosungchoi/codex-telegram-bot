import { telegramChatKey, telegramContextMeta, telegramTopicId } from "../telegram/context.js";
import { projectOptions, workspaceState } from "../workspace/store.js";

export function forumState(state) {
  state.forum ||= {};
  state.forum.groups ||= {};
  state.forum.jobs ||= {};
  return state.forum;
}

export function forumChatType(group) { return group.chatType || "supergroup"; }
export function forumRootTopicId(group) { return forumChatType(group) === "private" ? 0 : 1; }
export function forumTopicId(ctx) {
  return telegramContextMeta(ctx).messageThreadId ?? (ctx.chat?.type === "private" ? 0 : 1);
}
export function forumDestination(group, topicId) {
  const chatType = forumChatType(group);
  return { botId: group.botId, chatId: group.chatId, chatType,
    messageThreadId: telegramTopicId({ chatType, messageThreadId: topicId }) };
}
export function forumTopicKey(group, topicId) {
  return telegramChatKey({ chat: { id: group.chatId, type: forumChatType(group) }, message: { message_thread_id: topicId } });
}
export function forumGroup(state, ctx, botId) {
  const group = state.forum?.groups[String(ctx.chat?.id)];
  return group?.botId === botId && forumChatType(group) === ctx.chat?.type ? group : null;
}
export function forumTopicUrl(group, topicId, messageId = topicId) {
  if (forumChatType(group) === "private") return null;
  const match = String(group.chatId).match(/^-100(\d+)$/);
  return match ? `https://t.me/c/${match[1]}/${messageId}${messageId !== topicId && topicId !== 1 ? `?thread=${topicId}` : ""}` : null;
}

// A user's private-chat presets can be used when they set up their forum group.
export function forumProjects(state, userId) {
  const seen = new Set();
  return Object.entries(workspaceState(state).projects)
    .filter(([key]) => key.endsWith(`:${userId}`)).flatMap(([, projects]) => projects)
    .filter((p) => { if (seen.has(p.id)) return false; seen.add(p.id); return true; });
}

export function applyTopicBinding(r, group, topic) {
  if (!topic?.bindingId || !topic.cwd) return;
  const key = forumTopicKey(group, topic.id), chat = r.getChatState(key);
  if (chat.forumBinding?.id === topic.bindingId) return;
  for (const name of ["threadId", "threadAccountId", "accountThreads", "accountAttemptState"]) delete chat[name];
  for (const name of ["workingDirectory", "model", "modelReasoningEffort", "serviceTier"]) delete chat.options[name];
  Object.assign(chat.options, projectOptions(topic.preset?.options || {}), { workingDirectory: topic.cwd });
  chat.accountId = topic.preset?.accountId || "default";
  chat.forumBinding = { id: topic.bindingId, cwd: topic.role === "project" ? topic.cwd : undefined };
  chat.destination = forumDestination(group, topic.id);
  r.threadCache.delete(key);
}

export function assertTopicDirectory(chat, cwd) {
  if (chat.forumBinding?.cwd && chat.forumBinding.cwd !== cwd) {
    throw new Error("This topic is bound to another folder. Change its binding in /topics first.");
  }
}

export function registerForumContext(r) {
  r.bot.use((ctx, next) => {
    const group = forumGroup(r.state, ctx, r.bot.botInfo?.id);
    if (group && forumChatType(group) === "private"
      && (String(ctx.from?.id) !== String(group.ownerId) || String(ctx.from?.id) !== String(group.chatId))) return;
    if (group) applyTopicBinding(r, group, group.topics[forumTopicId(ctx)]);
    return next();
  });
}
