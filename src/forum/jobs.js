import { b, code, escapeHtml } from "../telegram/html.js";
import { directory, newId } from "../workspace/store.js";
import { applyTopicBinding, forumChatType, forumDestination, forumRootTopicId, forumState, forumTopicId, forumTopicKey, forumTopicUrl } from "./store.js";

export const LIVE_FORUM_JOBS = new Set(["queued", "running", "delivery_pending"]);

export function createForumJobs(r, { service, accounts, text: t, now = Date.now }) {
  const state = forumState(r.state);
  let ticking = false;
  const reporting = new Set();
  const find = (prepared) => state.jobs[prepared.id] || state.jobs[prepared.progressTurnId] || state.jobs[prepared.recovery?.queueItemId];
  function validateDelivery(_key, prepared) {
    const job = find(prepared);
    if (!job) return;
    try { validate(job); } catch (error) { error.suppressTelegramReply = true; throw error; }
  }
  function validate(job) {
    const group = state.groups[String(job.groupId)];
    if (!group) throw new Error("The project group is no longer registered.");
    service.authorize(job.userId, group, job.targetTopicId);
    service.authorize(job.userId, group, job.origin.messageThreadId ?? forumRootTopicId(group));
    if (job.origin.botId !== r.bot.botInfo?.id || job.origin.chatId !== group.chatId
      || (job.origin.chatType || "supergroup") !== forumChatType(group)) throw new Error("The originating bot or chat does not match.");
    return group;
  }
  async function dispatch(ctx, id, prompt) {
    const group = service.group(ctx);
    if (!prompt?.trim() || prompt.length > 8000) throw new Error("Use a text request of 1–8000 characters.");
    return service.exclusive(group, async () => {
      service.authorize(ctx.from.id, group, id);
      const topic = service.topic(group, id);
      if (topic.role !== "project" || !topic.cwd || topic.closed) throw new Error(t("unbound"));
      if (id === forumTopicId(ctx)) throw new Error("Send this request directly in the current project topic.");
      if (Object.values(state.jobs).filter((job) => LIVE_FORUM_JOBS.has(job.status)).length >= 20) throw new Error("Twenty dispatched jobs are already unfinished. Wait for one to finish.");
      await directory(topic.cwd);
      applyTopicBinding(r, group, topic);
      const key = forumTopicKey(group, id), chat = r.getChatState(key);
      const accountId = chat.accountId || "default";
      if ((await accounts.get(accountId)).status !== "ready") throw new Error("The project account needs sign-in.");
      const at = now(), jobId = `forum-${newId()}`;
      const job = { id: jobId, groupId: group.chatId, targetTopicId: id, targetKey: key, topicName: topic.name,
        bindingId: topic.bindingId, accountId, userId: ctx.from.id, prompt: prompt.trim(), createdAt: at, status: "queued",
        origin: { ...forumDestination(group, forumTopicId(ctx)), originMessageId: ctx.message?.message_id ?? ctx.callbackQuery?.message?.message_id } };
      const prepared = { id: jobId, kind: "forum", chatKey: key, ...forumDestination(group, id), accountId,
        text: job.prompt, inputText: r.applyPersonaPrompt(job.prompt), imagePaths: [],
        enqueuedAt: new Date(at).toISOString(), expiresAt: new Date(at + 86400_000).toISOString() };
      state.jobs[job.id] = job;
      // The queue and job receipt share one atomic state write. No execution is
      // repeated to recover a notification or a Telegram connection failure.
      const queued = await r.enqueuePendingTurn(key, prepared);
      if (!queued.ok) { delete state.jobs[job.id]; await r.saveState(); throw new Error("The project topic queue is full."); }
      await r.startQueueDrainIfIdle(key, r.createSyntheticCtx(prepared));
      return job;
    });
  }
  async function beforeTurn(key, prepared) {
    const job = find(prepared);
    if (!job) {
      if (prepared.kind === "forum") throw new Error("The dispatched job receipt is missing.");
      return;
    }
    validateDelivery(key, prepared);
    if (job.status === "completed" || job.status === "cancelled") {
      const error = new Error("This dispatched job has already finished."); error.suppressTelegramReply = true; throw error;
    }
    const group = state.groups[String(job.groupId)], topic = service.topic(group, job.targetTopicId);
    if (job.targetKey !== key || topic.bindingId !== job.bindingId || !topic.cwd || topic.closed) throw new Error("The project topic binding changed while this job was queued.");
    await directory(topic.cwd);
    if ((await accounts.get(job.accountId)).status !== "ready") throw new Error("The project account needs sign-in.");
    job.status = "running";
    await r.saveState();
  }
  async function recordResult(key, prepared, result) {
    const job = find(prepared);
    if (!job || job.targetKey !== key) return;
    if (job.status === "completed" || job.status === "cancelled") return;
    const previousStatus = job.status;
    job.status = result.delivered ? "completed" : result.cancelled ? "cancelled" : result.deliveryPending ? "delivery_pending" : "failed";
    job.threadId = result.threadId || "";
    if (!LIVE_FORUM_JOBS.has(job.status)) {
      job.finishedAt = now();
      if (previousStatus !== job.status) job.report = "pending";
      else job.report ||= "pending";
    }
    await r.saveState();
    if (job.report === "pending") await report(job);
  }
  function reportHtml(job) {
    return [b(t("report")), b(job.topicName), `${t(job.status)}`, "", escapeHtml((r.redactText?.(job.prompt) || job.prompt).slice(0, 700)),
      "", code(job.id)].join("\n");
  }
  async function report(job, { manual = false } = {}) {
    if (LIVE_FORUM_JOBS.has(job.status) || reporting.has(job.id) || (!manual && job.report !== "pending")) return;
    const group = validate(job);
    reporting.add(job.id);
    try {
      // Persist intent before sending. An interrupted/ambiguous send is exposed
      // in /topics -> jobs for an explicit resend, never replayed silently.
      job.report = "sending";
      await r.saveState();
      const url = forumTopicUrl(group, job.targetTopicId);
      const extra = url ? { reply_markup: { inline_keyboard: [[{ text: t("open"), url }]] } } : {};
      const ctx = r.createSyntheticCtx({ ...job.origin, userId: job.userId });
      const message = await r.replyHtml(ctx, reportHtml(job), extra);
      job.report = "sent"; job.reportMessageId = message?.message_id; job.reportedAt = now(); delete job.reportError;
    } catch (error) {
      job.report = "unknown";
      job.reportError = (r.redactText?.(error.message) || error.message).slice(0, 300);
    } finally { reporting.delete(job.id); await r.saveState(); }
  }
  async function reconcile(job) {
    if (job.report === "sending" && !reporting.has(job.id)) { job.report = "unknown"; await r.saveState(); }
    if (!LIVE_FORUM_JOBS.has(job.status)) return;
    const matches = (p) => p && (p.id === job.id || p.progressTurnId === job.id || p.recovery?.queueItemId === job.id);
    const active = r.activeTurns.get(job.targetKey);
    const delivery = Object.values(r.state.worker?.deliveries || {}).find((d) => d.chatKey === job.targetKey && d.jobId === job.id);
    if (delivery?.deliveryStatus === "delivery_sent") job.status = "completed";
    else if (matches(active?.currentPreparedTurn)) job.status = "running";
    else if (r.getPendingTurns(job.targetKey).some(matches)) job.status = "queued";
    else if (delivery && ["result_ready", "delivery_sending", "delivery_failed"].includes(delivery.deliveryStatus)) job.status = "delivery_pending";
    else if (now() - job.createdAt > 120_000) job.status = "interrupted";
    if (!LIVE_FORUM_JOBS.has(job.status)) { job.finishedAt = now(); job.report ||= "pending"; await r.saveState(); }
  }
  async function tick() {
    if (ticking || !r.bot.botInfo?.id) return;
    ticking = true;
    try {
      for (const job of Object.values(state.jobs)) {
        try { validate(job); await reconcile(job); if (job.report === "pending") await report(job); }
        catch { /* A changed allowlist/bot must not send to the former destination. */ }
      }
      const completed = Object.values(state.jobs).filter((job) => job.report === "sent" && !LIVE_FORUM_JOBS.has(job.status)).sort((a, b) => b.createdAt - a.createdAt);
      if (completed.length > 100) { for (const job of completed.slice(100)) delete state.jobs[job.id]; await r.saveState(); }
    } finally { ticking = false; }
  }
  return { dispatch, beforeTurn, validateDelivery, recordResult, reconcile, report, reportHtml, tick };
}
