import { b, code, escapeHtml } from "../telegram/html.js";
import { forumText } from "./messages.js";
import { createForumService } from "./service.js";
import { createForumJobs, LIVE_FORUM_JOBS } from "./jobs.js";
import { forumChatType, forumGroup, forumProjects, forumRootTopicId, forumState, forumTopicId, forumTopicKey, forumTopicUrl } from "./store.js";
import { isRegisteredTelegramCommandText } from "../telegram_commands.js";

const PAGE = 8;

export function createForumMenus(r, { ui, accounts, text, now = Date.now }) {
  const state = forumState(r.state);
  const t = (key) => forumText(r.state.ui?.language || r.config.telegramLanguage, key) || text(key);
  const service = createForumService(r, { accounts, now, text: t });
  const jobs = createForumJobs(r, { service, accounts, now, text: t });
  const btn = ui.button;
  const back = () => [btn(t("back"), "forum")];
  const projects = (ctx) => forumProjects(r.state, ctx.from.id);
  const jobFor = (ctx, id) => {
    const group = service.group(ctx), job = state.jobs[id];
    if (!job || job.groupId !== group.chatId || job.userId !== ctx.from.id) throw new Error(text("expired"));
    return job;
  };
  function allowedTopics(ctx, group) {
    return Object.values(group.topics).filter((topic) => {
      try { service.authorize(ctx.from.id, group, topic.id); return true; } catch { return false; }
    });
  }
  async function list(ctx, page = 0, notice = "") {
    const group = forumGroup(r.state, ctx, r.bot.botInfo?.id);
    if (!group) {
      const personal = ctx.chat?.type === "private";
      return ui.show(ctx, `${b(t("topics"))}\n\n${t(personal ? "privateSetupHint" : "setupHint")}`, [
        [btn(t(personal ? "privateSetup" : "setup"), "forum-setup")],
        ...(personal ? [[{ label: t("botFather"), url: "https://t.me/BotFather" }]] : [])
      ]);
    }
    service.group(ctx);
    const personal = forumChatType(group) === "private";
    const topics = allowedTopics(ctx, group);
    const rows = topics.slice(page * PAGE, (page + 1) * PAGE).map((topic) => [btn(`${topic.closed ? "⏸" : topic.cwd || topic.role !== "project" ? "🏷" : "⚠️"} ${topic.name}`, "forum-topic", { id: topic.id })]);
    const paging = [];
    if (page) paging.push(btn("←", "forum", { page: page - 1 }));
    if ((page + 1) * PAGE < topics.length) paging.push(btn("→", "forum", { page: page + 1 }));
    if (paging.length) rows.push(paging);
    rows.push([btn(t("create"), "forum-create")], [btn(t("dispatch"), "forum-dispatch"), btn(t("jobs"), "forum-jobs")]);
    if (forumTopicId(ctx) !== forumRootTopicId(group) && group.topics[forumTopicId(ctx)]) rows.push([btn(t("current"), "forum-topic", { id: forumTopicId(ctx) })]);
    return ui.show(ctx, `${b(t("topics"))}\n${notice}\n\n${t(personal ? "privateHint" : "managerHint")}`, rows);
  }
  async function card(ctx, id, notice = "") {
    const group = service.group(ctx), topic = service.topic(group, id);
    const personal = forumChatType(group) === "private";
    service.authorize(ctx.from.id, group, id);
    const url = forumTopicUrl(group, id);
    const rows = url ? [[{ label: t("open"), url }]] : [];
    if (topic.role === "project") {
      if (topic.cwd && !topic.closed && id !== forumTopicId(ctx)) rows.push([btn(t("dispatch"), "forum-prompt", { id })]);
      rows.push([btn(t("bind"), "forum-bind", { id })]);
      if (topic.cwd) rows.push([btn(t("unbind"), "forum-unbind-confirm", { id })]);
      rows.push([btn(t(personal ? (topic.closed ? "privateResume" : "privatePause") : (topic.closed ? "reopen" : "closeTopic")), topic.closed ? "forum-reopen" : "forum-close-confirm", { id })]);
    }
    rows.push(back());
    const chat = r.getChatState(forumTopicKey(group, id));
    return ui.show(ctx, [b(topic.name), notice, ...(personal && topic.role === "project" ? [t("privateOpenHint"), ...(topic.closed ? [t("privatePaused")] : [])] : []),
      topic.cwd ? code(topic.cwd.slice(0, 600)) : t(topic.role === "manager" ? "managerHint" : topic.role === "workspace" ? "privateHint" : "unbound"),
      ...(topic.cwd ? [`${text("account")}: ${code(chat.accountId || topic.preset?.accountId || "default")}`, `${text("model")}: ${code(r.getEffectiveOptions(forumTopicKey(group, id)).model || "default")}`] : [])].join("\n"), rows);
  }
  async function chooseProject(ctx, { id, page = 0 } = {}) {
    service.group(ctx);
    const list = projects(ctx);
    const rows = list.slice(page * PAGE, (page + 1) * PAGE).map((p) => [btn(p.name, "forum-project", { id, projectId: p.id })]);
    const nav = [];
    if (page) nav.push(btn("←", "forum-choose-project", { id, page: page - 1 }));
    if ((page + 1) * PAGE < list.length) nav.push(btn("→", "forum-choose-project", { id, page: page + 1 }));
    if (nav.length) rows.push(nav);
    rows.push([btn(t("path"), "forum-path", { id })], back());
    return ui.show(ctx, `${b(t("bind"))}\n${t("pathHint")}`, rows);
  }
  async function chooseTarget(ctx, prompt, page = 0) {
    const group = service.group(ctx);
    const list = allowedTopics(ctx, group).filter((p) => p.role === "project" && p.cwd && !p.closed && p.id !== forumTopicId(ctx));
    const rows = list.slice(page * PAGE, (page + 1) * PAGE).map((p) => [btn(p.name, prompt ? "forum-send" : "forum-prompt", { id: p.id, prompt })]);
    const nav = [];
    if (page) nav.push(btn("←", "forum-targets", { prompt, page: page - 1 }));
    if ((page + 1) * PAGE < list.length) nav.push(btn("→", "forum-targets", { prompt, page: page + 1 }));
    if (nav.length) rows.push(nav);
    rows.push(back());
    return ui.show(ctx, `${b(t("dispatch"))}\n${list.length ? t("choose") : t("noTopics")}\n\n${escapeHtml(String(prompt || "").slice(0, 1200))}`, rows);
  }
  async function jobList(ctx, page = 0) {
    const group = service.group(ctx);
    const list = Object.values(state.jobs).filter((job) => job.groupId === group.chatId && job.userId === ctx.from.id).sort((a, b) => b.createdAt - a.createdAt);
    const rows = list.slice(page * PAGE, (page + 1) * PAGE).map((job) => [btn(`${t(job.status)} · ${job.topicName}`, "forum-job", { id: job.id })]);
    const nav = [];
    if (page) nav.push(btn("←", "forum-jobs", { page: page - 1 }));
    if ((page + 1) * PAGE < list.length) nav.push(btn("→", "forum-jobs", { page: page + 1 }));
    if (nav.length) rows.push(nav);
    rows.push([btn(text("refresh"), "forum-jobs", { page })], back());
    return ui.show(ctx, `${b(t("jobs"))}\n${list.length ? "" : text("empty")}`, rows);
  }
  async function jobCard(ctx, job, notice = "") {
    await jobs.reconcile(job);
    const group = service.group(ctx), url = forumTopicUrl(group, job.targetTopicId);
    const rows = url ? [[{ label: t("open"), url }]] : [];
    if (!LIVE_FORUM_JOBS.has(job.status)) rows.push([btn(t("retryReport"), "forum-report", { id: job.id })]);
    rows.push([btn(text("refresh"), "forum-job", { id: job.id })], [btn(t("jobs"), "forum-jobs")], back());
    return ui.show(ctx, `${notice}\n${jobs.reportHtml(job)}${job.report === "unknown" ? `\n\n${t("reportUnknown")}` : ""}`, rows);
  }
  async function selectProject(ctx, id, selected) {
    if (id != null) {
      await service.bind(ctx, id, selected);
      return card(ctx, id, t("linked"));
    }
    return ui.ask(ctx, t("name"), { stage: "forum-name", selected }, code(selected.name));
  }
  async function onInput(ctx, value, data) {
    if (data.stage === "forum-path") return selectProject(ctx, data.id, await service.resolve(ctx, value));
    if (data.stage === "forum-name") {
      await ui.clear(ctx);
      const topic = await service.create(ctx, value, data.selected);
      return card(ctx, topic.id, t("linked"));
    }
    if (data.stage === "forum-prompt") {
      if (value.length > 8000) throw new Error(text("promptHint"));
      await ui.clear(ctx);
      return jobCard(ctx, await jobs.dispatch(ctx, data.id, value), t("sent"));
    }
    throw new Error(text("expired"));
  }
  async function action(ctx, a) {
    if (a.type === "forum") return list(ctx, a.page);
    if (a.type === "forum-setup") {
      const group = await service.setup(ctx);
      return list(ctx, 0, t(forumChatType(group) === "private" ? "privateReady" : "ready"));
    }
    if (a.type === "forum-topic") return card(ctx, a.id);
    if (["forum-create", "forum-bind", "forum-choose-project"].includes(a.type)) return chooseProject(ctx, a);
    if (a.type === "forum-path") return ui.ask(ctx, t("path"), { stage: a.type, id: a.id }, t("pathHint"));
    if (a.type === "forum-project") {
      const selected = projects(ctx).find((p) => p.id === a.projectId);
      if (!selected) throw new Error(text("expired"));
      return selectProject(ctx, a.id, selected);
    }
    if (a.type === "forum-dispatch" || a.type === "forum-targets") return chooseTarget(ctx, a.prompt, a.page);
    if (a.type === "forum-prompt") return ui.ask(ctx, t("prompt"), { stage: a.type, id: a.id }, text("promptHint"));
    if (a.type === "forum-send") { await ui.clear(ctx); return jobCard(ctx, await jobs.dispatch(ctx, a.id, a.prompt), t("sent")); }
    if (a.type === "forum-jobs") return jobList(ctx, a.page);
    if (a.type === "forum-job") return jobCard(ctx, jobFor(ctx, a.id));
    if (a.type === "forum-report") {
      const job = jobFor(ctx, a.id); await ui.clear(ctx); await jobs.report(job, { manual: true }); return jobCard(ctx, job);
    }
    if (a.type === "forum-unbind-confirm" || a.type === "forum-close-confirm") {
      const closeHint = forumChatType(service.group(ctx)) === "private" ? "privateConfirmPause" : "confirmClose";
      return ui.show(ctx, b(t(a.type === "forum-unbind-confirm" ? "unbindHint" : closeHint)), [
        [btn(text("confirm"), a.type === "forum-unbind-confirm" ? "forum-unbind" : "forum-close", { id: a.id })], back()
      ]);
    }
    if (["forum-unbind", "forum-close", "forum-reopen"].includes(a.type)) {
      await ui.clear(ctx); await service.update(ctx, a.id, a.type.slice(6)); return card(ctx, a.id);
    }
    throw new Error(text("expired"));
  }
  function registerCommands() {
    r.bot.command("forum_setup", (ctx) => ui.guard(ctx, () => action(ctx, { type: "forum-setup" })));
    r.bot.command("topics", (ctx) => ui.guard(ctx, () => list(ctx)));
    r.bot.command("dispatch", (ctx) => ui.guard(ctx, async () => {
      const value = r.getCommandArgs(ctx);
      if (!value) return chooseTarget(ctx);
      const separator = value.indexOf("|");
      if (separator < 0) return chooseTarget(ctx, value);
      const target = value.slice(0, separator).trim(), prompt = value.slice(separator + 1).trim();
      const group = service.group(ctx);
      const matches = allowedTopics(ctx, group).filter((p) => p.name.toLocaleLowerCase() === target.toLocaleLowerCase() || `#${p.id}` === target);
      if (matches.length !== 1) throw new Error("Use an exact topic name or #topicId, followed by | and your request.");
      return jobCard(ctx, await jobs.dispatch(ctx, matches[0].id, prompt), t("sent"));
    }));
    r.bot.action("w:forum", (ctx) => ui.guard(ctx, () => list(ctx)));
  }
  function registerMessages() {
    r.bot.use(async (ctx, next) => {
      const group = forumGroup(r.state, ctx, r.bot.botInfo?.id);
      if (!group) return next();
      const id = forumTopicId(ctx), message = ctx.message;
      if (!group.topics[id]) {
        if (Object.values(group.topics).filter((item) => item.role === "project").length >= 60) return r.replyHtml(ctx, t("noTopics"));
        group.topics[id] = { id, name: message?.forum_topic_created?.name || `#${id}`,
          role: id === forumRootTopicId(group) ? (forumChatType(group) === "private" ? "workspace" : "manager") : "project" };
        await r.saveState();
      }
      const topic = group.topics[id];
      if (message?.forum_topic_created || message?.forum_topic_edited || message?.forum_topic_closed || message?.forum_topic_reopened) {
        if (message.forum_topic_edited?.name) topic.name = message.forum_topic_edited.name;
        if (message.forum_topic_closed) topic.closed = true;
        if (message.forum_topic_reopened) topic.closed = false;
        await r.saveState();
        if (!message.forum_topic_created || topic.cwd || topic.role !== "project") return;
        return ui.guard(ctx, async () => {
          const candidates = projects(ctx).filter((p) => p.name.toLocaleLowerCase() === topic.name.toLocaleLowerCase());
          if (candidates.length === 1) await service.bind(ctx, id, candidates[0]);
          return card(ctx, id);
        });
      }
      const command = message?.text?.trimStart().split(/\s+/, 1)[0].split("@")[0];
      const startsTurn = ["/new", "/resume", "/resume_last"].includes(command) || ["act:new", "act:resume_last"].includes(ctx.callbackQuery?.data);
      if (topic.role === "project" && (!topic.cwd || topic.closed) && (startsTurn || (message && !isRegisteredTelegramCommandText(message)))) {
        return ui.guard(ctx, () => card(ctx, id));
      }
      if (topic.role !== "manager") return next();
      if (startsTurn) return ui.guard(ctx, () => list(ctx));
      if (!message || isRegisteredTelegramCommandText(message)) return next();
      if (!message.text) return r.replyHtml(ctx, t("attachments"));
      if (message.text.length > 8000) return r.replyHtml(ctx, text("promptHint"));
      return ui.guard(ctx, () => chooseTarget(ctx, message.text.trim()));
    });
  }
  return { action, onInput, jobs, service, registerCommands, registerMessages };
}
