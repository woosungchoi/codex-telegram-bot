import { b, code, escapeHtml } from "../telegram/html.js";
import { editOrReplyTelegramHtml } from "../telegram/api.js";
import { authorizeTelegramUpdate } from "../security.js";
import { createAccountStore } from "../accounts/store.js";
import { accountConfig, rememberAccountThread, selectedAccountId } from "../accounts/context.js";
import { createWorkspaceBackend, readSessionTail } from "./backend.js";
import { sessionButtonLabel, sessionTitle } from "./session_labels.js";
import { createTaskScheduler, taskChatKey } from "./scheduler.js";
import { createTaskDashboard } from "./dashboard.js";
import { createWorkspaceUi } from "./ui.js";
import { workspaceText } from "./messages.js";
import { browseFolders, cleanName, destinationKey, directory, newId, projectOptions, scopeKey, sortedProjects, topicId, workspaceState } from "./store.js";
import { nextOccurrence, parseSchedule, scheduleLabel } from "./schedule.js";
import { createForumMenus } from "../forum/controller.js";
import { assertTopicDirectory } from "../forum/store.js";
import { isRegisteredTelegramCommandText } from "../telegram_commands.js";

const PAGE = 8;
const clip = (value, length = 1000) => String(value || "").slice(0, length);

export function registerWorkspaceFlowBoundary(r) {
  r.bot.use(async (ctx, next) => {
    const data = ctx.callbackQuery?.data;
    if (isRegisteredTelegramCommandText(ctx.message) || (data && !data.startsWith("ws:"))) {
      const flows = workspaceState(r.state).flows;
      if (ctx.chat && ctx.from && flows[scopeKey(ctx)]) { delete flows[scopeKey(ctx)]; await r.saveState(); }
    }
    return next();
  });
}

export function registerWorkspaceMenus(r, {
  accounts = createAccountStore(r.config), backend = createWorkspaceBackend(r.config),
  readTail = readSessionTail, browse = browseFolders, validateDirectory = directory,
  now = Date.now, timers = { setInterval, clearInterval }
} = {}) {
  const state = workspaceState(r.state);
  const t = (key) => workspaceText(r.state.ui?.language || r.config.telegramLanguage, key);
  const ui = createWorkspaceUi(r, t, { now });
  const btn = ui.button;
  const scheduler = createTaskScheduler(r, { accounts, now });
  const dashboard = createTaskDashboard(r, { accounts, text: t, now });
  const forum = createForumMenus(r, { ui, accounts, text: t, now });
  let timer, stopped = false, watching = false;
  const safe = (s) => clip(r.redactText?.(s) || s, 1600);
  const meta = (ctx) => ({ chatId: ctx.chat.id, chatType: ctx.chat.type, messageThreadId: topicId(ctx), chatKey: r.getChatKey(ctx), botId: r.bot.botInfo.id });
  const projects = (ctx) => state.projects[scopeKey(ctx)] ||= [];
  const project = (ctx, id) => { const p = projects(ctx).find((v) => v.id === id); if (!p) throw new Error(t("expired")); return p; };
  const task = (ctx, id) => { const item = state.tasks[id]; if (!item || item.owner !== scopeKey(ctx)) throw new Error(t("expired")); return item; };
  const date = (at) => at ? (r.formatDateTime?.(at) || new Date(at).toISOString()) : "—";
  const currentAccount = (ctx) => selectedAccountId(r.getChatState(r.getChatKey(ctx)));
  const nav = (type) => [btn(t("back"), type)];

  function assertIdle(ctx) {
    const key = r.getChatKey(ctx);
    if (r.activeTurns.has(key) || r.getSideTurnCount(key) || r.getPendingTurns(key).length || r.hasPendingFinalDelivery(key)) throw new Error(t("busy"));
  }
  function assertAdmin(ctx) {
    if (ctx.chat.type !== "private" || !r.config.codexAccountAdminUserIds?.has(String(ctx.from.id))) throw new Error(t("admin"));
  }
  function assertAccountIdle(id) {
    for (const [key, a] of r.activeTurns) {
      const c = r.getChatState(key);
      if ((c.accountAttemptState?.accountId || c.threadAccountId || c.accountId || "default") === id || a.currentPreparedTurn?.accountId === id) throw new Error(t("busy"));
    }
    for (const key of Object.keys(r.state.chats || {})) {
      if (selectedAccountId(r.getChatState(key)) === id && r.getSideTurnCount(key)) throw new Error(t("busy"));
    }
  }
  async function readyAccount(id) {
    const a = await accounts.get(id);
    if (a.status !== "ready") throw new Error("The selected account needs sign-in. Open /accounts.");
    return a;
  }
  function resetThread(chat, id) {
    delete chat.threadId;
    delete chat.threadAccountId;
    delete chat.accountAttemptState;
    if (chat.accountThreads) delete chat.accountThreads[id];
  }
  function currentPreset(ctx, cwd) {
    const options = r.getEffectiveOptions(r.getChatKey(ctx));
    return { cwd: cwd || options.workingDirectory, accountId: currentAccount(ctx), options: { ...projectOptions(options), workingDirectory: cwd || options.workingDirectory } };
  }
  async function projectList(ctx, query = "", page = 0) {
    const list = sortedProjects(projects(ctx), query);
    const start = Math.max(0, Math.min(page, Math.max(0, Math.ceil(list.length / PAGE) - 1))) * PAGE;
    const rows = list.slice(start, start + PAGE).map((p) => [btn(`${p.favorite ? "⭐" : "📁"} ${p.name}`, "project", { id: p.id })]);
    const paging = [];
    if (start) paging.push(btn("←", "projects", { query, page: start / PAGE - 1 }));
    if (start + PAGE < list.length) paging.push(btn("→", "projects", { query, page: start / PAGE + 1 }));
    if (paging.length) rows.push(paging);
    rows.push([btn(t("saveCurrent"), "project-save"), btn(t("browse"), "browse")],
      [btn(t("path"), "project-path"), btn(t("search"), "project-search")]);
    if (query) rows.push([btn(t("clearSearch"), "projects")]);
    return ui.show(ctx, `${b(t("projects"))}\n${query ? code(query) : ""}\n${list.length ? `${start + 1}–${Math.min(start + PAGE, list.length)} / ${list.length}` : t("empty")}`, rows);
  }
  async function projectCard(ctx, p, notice = "") {
    const account = await accounts.get(p.accountId).catch(() => ({ label: p.accountId }));
    return ui.show(ctx, [b(t("projects")), notice, b(p.name), code(p.cwd), `${t("account")}: ${b(account.label)}`,
      `${t("model")}: ${code(p.options.model || "default")} · ${code(p.options.modelReasoningEffort || "default")}`].join("\n"), [
      [btn(t("open"), "project-open", { id: p.id }), btn(t("favorite"), "project-favorite", { id: p.id })],
      [btn(t("capture"), "project-capture", { id: p.id })],
      [btn(t("rename"), "project-rename", { id: p.id }), btn(t("remove"), "project-remove", { id: p.id })], nav("projects")
    ]);
  }
  async function folderList(ctx, cwd, page = 0) {
    const listing = await browse(cwd || r.getEffectiveOptions(r.getChatKey(ctx)).workingDirectory);
    const start = Math.max(0, page) * PAGE;
    const rows = listing.folders.slice(start, start + PAGE).map((p) => [btn(`📂 ${p.name}`, "browse", { cwd: p.cwd })]);
    const paging = [];
    if (page) paging.push(btn("←", "browse", { cwd: listing.cwd, page: page - 1 }));
    if (start + PAGE < listing.folders.length) paging.push(btn("→", "browse", { cwd: listing.cwd, page: page + 1 }));
    if (paging.length) rows.push(paging);
    rows.push([btn(t("chooseFolder"), "project-save", { cwd: listing.cwd })],
      [btn(t("parent"), "browse", { cwd: listing.parent }), btn(t("path"), "project-path")], nav("projects"));
    return ui.show(ctx, `${b(t("browse"))}\n${code(listing.cwd)}${listing.capped ? `\n${t("capped")}` : ""}`, rows);
  }
  async function sessionList(ctx, args = {}) {
    const accountId = args.accountId || currentAccount(ctx);
    const account = await accounts.get(accountId);
    const scope = args.scope === "all" ? "all" : "project";
    const cwd = scope === "all" ? null : args.cwd || r.getEffectiveOptions(r.getChatKey(ctx)).workingDirectory;
    const view = { accountId, scope, cwd, query: args.query || "", cursor: args.cursor || null, cursors: args.cursors || [] };
    const firstPage = { ...view, cursor: null, cursors: [] };
    const result = await backend.listSessions(accountId, { cwd, query: view.query, cursor: view.cursor });
    const timeZone = r.state.ui?.timeZone || r.config.telegramTimeZone || "UTC";
    const rows = (result.data || []).map((s) => [btn(sessionButtonLabel({ ...s, cwd: safe(s.cwd || "") }, safe(sessionTitle(s) || t("untitledSession")),
      { timeZone, showFolder: scope === "all" }), "session", { accountId, session: s, view })]);
    const cursors = view.cursors;
    const paging = [];
    if (cursors.length) paging.push(btn("←", "sessions", { ...view, cursor: cursors.at(-1), cursors: cursors.slice(0, -1) }));
    if (result.nextCursor) paging.push(btn("→", "sessions", { ...view, cursor: result.nextCursor, cursors: [...cursors, view.cursor] }));
    if (paging.length) rows.push(paging);
    rows.push([btn(`${scope === "project" ? "✅ " : ""}${t("sessionProject")}`, "sessions", { ...firstPage, scope: "project", cwd: null }),
      btn(`${scope === "all" ? "✅ " : ""}${t("sessionAll")}`, "sessions", { ...firstPage, scope: "all", cwd: null })]);
    rows.push([btn(t("search"), "session-search", { view: firstPage }), btn(t("refresh"), "sessions", firstPage)]);
    if (view.query) rows.push([btn(t("clearSearch"), "sessions", { ...firstPage, query: "" })]);
    rows.push(...(await accounts.list()).map((a) => [btn(`${a.id === accountId ? "✅ " : ""}${a.label}`, "sessions", { ...firstPage, accountId: a.id })]));
    return ui.show(ctx, [b(t("sessions")), `${t("account")}: ${b(account.label)}`, b(t(scope === "all" ? "sessionAll" : "sessionProject")),
      cwd ? code(safe(cwd)) : t("sessionAllHint"), t("sessionLabelHint"), view.query ? code(safe(view.query)) : "", result.data?.length ? "" : t("empty")].join("\n"), rows);
  }
  async function sessionHtml(accountId, session) {
    const tail = await readTail(session.path, accountConfig(r.config, accountId).codexSessionsDir);
    const lines = [b(t("sessions")), code(session.id), code(clip(session.cwd, 600)),
      `${date(session.updatedAt * 1000)} · ${t(tail.activity)}`, "", b(t("preview")), escapeHtml(safe(sessionTitle(session) || t("untitledSession")))];
    for (const m of tail.messages) lines.push("", b(m.role), escapeHtml(safe(m.text).slice(-400)));
    return { html: lines.join("\n"), activity: tail.activity };
  }
  async function sessionCard(ctx, accountId, listed, watch = false, view = { accountId }) {
    await accounts.get(accountId);
    const session = await backend.readSession(accountId, listed.id);
    const { html } = await sessionHtml(accountId, session);
    return ui.show(ctx, html + (watch ? `\n\n${t("watchHint")}` : ""), [
      [btn(t("resume"), "session-resume", { accountId, session }),
        btn(t(watch ? "stopWatch" : "watch"), watch ? "session" : "session-watch", { accountId, session, view })],
      [btn(t("back"), "sessions", view)]
    ], { kind: watch ? "watch" : "session", accountId, session });
  }
  async function taskList(ctx) {
    const list = Object.values(state.tasks).filter((item) => item.owner === scopeKey(ctx));
    const rows = list.map((item) => [btn(`${item.enabled ? "▶" : "⏸"} ${item.name}`, "task", { id: item.id })]);
    rows.push([btn(t("addTask"), "task-new"), btn(t("refresh"), "tasks")]);
    return ui.show(ctx, `${b(t("tasks"))}\n${list.length ? `${list.length} / 20` : t("empty")}`, rows);
  }
  async function taskHtml(item) {
    const account = await accounts.get(item.accountId).catch(() => ({ label: item.accountId }));
    return [b(item.name), code(item.options.workingDirectory), `${t("account")}: ${b(account.label)}`,
      `${t("model")}: ${code(item.options.model || "default")}`, code(scheduleLabel(item.schedule)),
      `${t("nextRun")}: ${code(date(item.nextAt))}`, "", escapeHtml(clip(item.prompt, 1000))].join("\n");
  }
  async function taskCard(ctx, item) {
    await scheduler.reconcile(item);
    const history = [...(item.history || []), ...(item.run ? [item.run] : [])].slice(-5)
      .map((run) => `${date(run.startedAt)} · ${t(run.status)}`).join("\n");
    return ui.show(ctx, `${b(t("tasks"))}\n${t(item.enabled ? "enabled" : "disabled")}\n${await taskHtml(item)}\n\n${b(t("history"))}\n${escapeHtml(history || "—")}${item.error ? `\n${code(item.error)}` : ""}`, [
      [btn(t("runNow"), "task-run-confirm", { id: item.id }), btn(t(item.enabled ? "disable" : "enable"), "task-toggle", { id: item.id })],
      [btn(t("rename"), "task-edit", { id: item.id, field: "name" }), btn(t("editPrompt"), "task-edit", { id: item.id, field: "prompt" })],
      [btn(t("editSchedule"), "task-edit", { id: item.id, field: "schedule" }), btn(t("editProject"), "task-edit", { id: item.id, field: "project" })],
      [btn(t("stop"), "task-stop-confirm", { id: item.id }), btn(t("remove"), "task-remove", { id: item.id })], nav("tasks")
    ]);
  }
  function snapshotForTask(ctx, preset = currentPreset(ctx)) {
    return { projectName: preset.name || preset.cwd, accountId: preset.accountId,
      options: { ...r.getEffectiveOptions(r.getChatKey(ctx)), ...preset.options, workingDirectory: preset.cwd } };
  }
  async function chooseTaskProject(ctx, draft, editing = false) {
    const choices = [[btn(t("currentProject"), "task-project", { draft, editing, preset: currentPreset(ctx) })],
      ...projects(ctx).map((p) => [btn(p.name, "task-project", { draft, editing, preset: p })])];
    return ui.show(ctx, `${b(t("chooseProject"))}\n${escapeHtml(draft.name)}`, choices);
  }
  async function chooseSchedule(ctx, draft) {
    return ui.show(ctx, `${b(t("schedule"))}\n${code(r.state.ui?.timeZone || r.config.telegramTimeZone || "UTC")}`, [
      ...["once", "daily", "weekly", "monthly", "interval"].map((kind) => [btn(t(kind), "task-schedule", { draft, kind })])
    ]);
  }
  async function confirmTask(ctx, draft) {
    return ui.show(ctx, `${b(t("confirmTask"))}\n\n${await taskHtml(draft)}`, [[btn(t("save"), "task-save", { draft })], nav("tasks")]);
  }
  async function mcpList(ctx, accountId = currentAccount(ctx), health = false, page = 0) {
    assertAdmin(ctx);
    const cwd = r.getEffectiveOptions(r.getChatKey(ctx)).workingDirectory;
    const account = await accounts.get(accountId);
    const result = await backend.readMcp(accountId, cwd, health);
    const rows = result.rows.slice(page * PAGE, (page + 1) * PAGE).map((s) => [
      btn(`${s.enabled ? "✅" : "⏸"} ${s.name}`, "mcp-server", { accountId, cwd, server: s, version: result.version })
    ]);
    const navs = [];
    if (page) navs.push(btn("←", "mcp", { accountId, page: page - 1 }));
    if ((page + 1) * PAGE < result.rows.length) navs.push(btn("→", "mcp", { accountId, page: page + 1 }));
    if (navs.length) rows.push(navs);
    rows.push([btn(t("health"), "mcp", { accountId, health: true }), btn(t("reload"), "mcp-reload", { accountId })]);
    rows.push(...(await accounts.list()).map((a) => [btn(a.label, "mcp", { accountId: a.id })]));
    const details = result.rows.slice(page * PAGE, (page + 1) * PAGE).map((s) => `${escapeHtml(s.name)} · ${t(s.status)}${s.tools != null ? ` · ${s.tools} tools` : ""}`).join("\n");
    return ui.show(ctx, `${b(t("mcp"))}\n${t("account")}: ${b(account.label)}\n${code(cwd)}\n\n${details || t("empty")}\n\n${t("mcpHint")}`, rows);
  }
  async function dashboardMenu(ctx) {
    const dest = meta(ctx);
    const on = state.panelPreferences[destinationKey(dest)] !== false;
    return ui.show(ctx, `${await dashboard.describe(dest)}\n\n${t("autoPanel")}: ${t(on ? "enabled" : "disabled")}`, [
      [btn(t(on ? "disable" : "enable"), "dashboard-toggle"), btn(t("refresh"), "dashboard")],
      [btn(t("stop"), "stop"), btn(t("tasks"), "tasks")]
    ]);
  }
  async function onInput(ctx, value, data) {
    if (data.stage?.startsWith("forum-")) return forum.onInput(ctx, value, data);
    if (data.stage === "project-search") return projectList(ctx, clip(value, 100));
    if (data.stage === "project-path") return folderList(ctx, await validateDirectory(value));
    if (data.stage === "project-name") {
      const name = cleanName(value);
      const list = projects(ctx);
      if (list.length >= 60) throw new Error("At most 60 saved projects per user/chat/topic.");
      const cwd = await validateDirectory(data.preset.cwd);
      const p = { ...data.preset, cwd, name, id: newId(), favorite: false, lastUsedAt: now() };
      list.push(p); await ui.clear(ctx); return projectCard(ctx, p, t("saved"));
    }
    if (data.stage === "project-rename") {
      const p = project(ctx, data.id); p.name = cleanName(value); await ui.clear(ctx); return projectCard(ctx, p, t("saved"));
    }
    if (data.stage === "session-search") return sessionList(ctx, { ...(data.view || { accountId: data.accountId }), query: clip(value, 100), cursor: null, cursors: [] });
    if (data.stage === "task-name") {
      const draft = { ...data.draft, name: cleanName(value) };
      if (data.editing) return confirmTask(ctx, draft);
      return ui.ask(ctx, t("prompt"), { stage: "task-prompt", draft }, t("promptHint"));
    }
    if (data.stage === "task-prompt") {
      if (value.length > 8000) throw new Error(t("promptHint"));
      const draft = { ...data.draft, prompt: value };
      return data.editing ? confirmTask(ctx, draft) : chooseTaskProject(ctx, draft);
    }
    if (data.stage === "task-time") {
      const schedule = parseSchedule(data.kind, value, data.timeZone, now());
      return confirmTask(ctx, { ...data.draft, schedule, nextAt: nextOccurrence(schedule, now()) });
    }
    throw new Error(t("expired"));
  }
  async function action(ctx, a) {
    if (a.type === "forum" || a.type.startsWith("forum-")) return forum.action(ctx, a);
    if (a.type === "close") return ui.close(ctx);
    if (a.type === "home") { await ui.clear(ctx); return r.sendPanel(ctx, "main"); }
    if (a.type === "projects") return projectList(ctx, a.query, a.page);
    if (a.type === "project") return projectCard(ctx, project(ctx, a.id));
    if (a.type === "browse") return folderList(ctx, a.cwd, a.page);
    if (a.type === "project-path") return ui.ask(ctx, t("path"), { stage: a.type }, t("pathPrompt"));
    if (a.type === "project-search") return ui.ask(ctx, t("search"), { stage: a.type }, t("searchPrompt"));
    if (a.type === "project-save") return ui.ask(ctx, t("name"), { stage: "project-name", preset: currentPreset(ctx, a.cwd) });
    if (a.type.startsWith("project-")) {
      const p = project(ctx, a.id);
      if (a.type === "project-open") {
        assertIdle(ctx); await readyAccount(p.accountId); await validateDirectory(p.cwd); assertIdle(ctx);
        const chat = r.getChatState(r.getChatKey(ctx));
        assertTopicDirectory(chat, p.cwd);
        for (const key of ["model", "modelReasoningEffort", "serviceTier"]) delete chat.options[key];
        Object.assign(chat.options, p.options, { workingDirectory: p.cwd });
        chat.accountId = p.accountId; resetThread(chat, p.accountId); p.lastUsedAt = now();
        r.threadCache.delete(r.getChatKey(ctx)); await ui.clear(ctx); return projectCard(ctx, p, t("projectOpened"));
      }
      if (a.type === "project-favorite") p.favorite = !p.favorite;
      if (a.type === "project-capture") { const snapshot = currentPreset(ctx, p.cwd); p.accountId = snapshot.accountId; p.options = snapshot.options; }
      if (a.type === "project-rename") return ui.ask(ctx, t("name"), { stage: a.type, id: p.id });
      if (a.type === "project-remove") return ui.show(ctx, `${b(p.name)}\n${t("removeHint")}`, [[btn(t("confirm"), "project-delete", { id: p.id })], nav("projects")]);
      if (a.type === "project-delete") { state.projects[scopeKey(ctx)] = projects(ctx).filter((x) => x.id !== p.id); await ui.clear(ctx); return projectList(ctx); }
      await ui.clear(ctx); return projectCard(ctx, p, t("saved"));
    }
    if (a.type === "sessions") return sessionList(ctx, a);
    if (a.type === "session" || a.type === "session-watch") return sessionCard(ctx, a.accountId, a.session, a.type === "session-watch", a.view);
    if (a.type === "session-search") return ui.ask(ctx, t("search"), { stage: a.type, view: a.view || { accountId: a.accountId } }, t("searchPrompt"));
    if (a.type === "session-resume") {
      assertIdle(ctx); await readyAccount(a.accountId);
      const session = await backend.readSession(a.accountId, a.session.id);
      await validateDirectory(session.cwd);
      const tail = await readTail(session.path, accountConfig(r.config, a.accountId).codexSessionsDir, { maxBytes: 4 * 1024 * 1024 });
      if (tail.activity === "running" || session.status?.type === "active") throw new Error(t("busy"));
      for (const key of r.activeTurns.keys()) {
        const c = r.getChatState(key);
        if (c.threadId === session.id || c.accountAttemptState?.threadId === session.id) throw new Error(t("busy"));
      }
      assertIdle(ctx);
      const key = r.getChatKey(ctx), chat = r.getChatState(key);
      assertTopicDirectory(chat, await validateDirectory(session.cwd));
      chat.accountId = a.accountId; chat.options.workingDirectory = session.cwd;
      rememberAccountThread(chat, session.id, a.accountId); r.threadCache.delete(key);
      await ui.clear(ctx); return ui.show(ctx, `${b(t("resumed"))}\n${code(session.id)}\n${code(session.cwd)}`, [nav("sessions")]);
    }
    if (a.type === "tasks") return taskList(ctx);
    if (a.type === "task") return taskCard(ctx, task(ctx, a.id));
    if (a.type === "task-new") return ui.ask(ctx, t("name"), { stage: "task-name", draft: { id: newId() } });
    if (a.type === "task-project") {
      const draft = { ...a.draft, ...snapshotForTask(ctx, a.preset) };
      return a.editing ? confirmTask(ctx, draft) : chooseSchedule(ctx, draft);
    }
    if (a.type === "task-schedule") return ui.ask(ctx, t(a.kind), { stage: "task-time", kind: a.kind, draft: a.draft,
      timeZone: r.state.ui?.timeZone || r.config.telegramTimeZone || "UTC" }, t("scheduleHint"));
    if (a.type === "task-save") {
      const existing = state.tasks[a.draft.id];
      if (existing && task(ctx, a.draft.id) && scheduler.busy(existing)) throw new Error(t("busy"));
      if (!existing && Object.values(state.tasks).filter((v) => v.owner === scopeKey(ctx)).length >= 20) throw new Error("At most 20 scheduled tasks per user/chat/topic.");
      await readyAccount(a.draft.accountId); await validateDirectory(a.draft.options.workingDirectory);
      if (existing && scheduler.busy(existing)) throw new Error(t("busy"));
      const nextAt = existing && JSON.stringify(existing.schedule) === JSON.stringify(a.draft.schedule)
        ? existing.nextAt : nextOccurrence(a.draft.schedule, now());
      if (!nextAt && (!existing || existing.enabled)) throw new Error("Choose a future schedule.");
      const saved = { ...existing, ...a.draft, owner: scopeKey(ctx), userId: String(ctx.from.id), destination: meta(ctx),
        enabled: existing?.enabled ?? true, nextAt, run: existing?.run, history: existing?.history || [] };
      state.tasks[saved.id] = saved; await ui.clear(ctx); return taskCard(ctx, saved);
    }
    if (a.type.startsWith("task-")) {
      const item = task(ctx, a.id);
      if (a.type === "task-toggle") {
        if (!item.enabled) { item.nextAt = nextOccurrence(item.schedule, now()); if (!item.nextAt) throw new Error("Choose a future schedule."); }
        item.enabled = !item.enabled; delete item.error; await ui.clear(ctx); return taskCard(ctx, item);
      }
      if (["task-run-confirm", "task-stop-confirm", "task-remove"].includes(a.type)) {
        const next = { "task-run-confirm": "task-run", "task-stop-confirm": "task-stop", "task-remove": "task-delete" }[a.type];
        return ui.show(ctx, `${b(t(a.type === "task-run-confirm" ? "runConfirm" : a.type === "task-remove" ? "removeHint" : "stop"))}\n\n${await taskHtml(item)}`,
          [[btn(t("confirm"), next, { id: item.id })], [btn(t("back"), "task", { id: item.id })]]);
      }
      if (a.type === "task-run") { await ui.clear(ctx); await scheduler.run(item, { manual: true }); return taskCard(ctx, item); }
      if (a.type === "task-stop") { await ui.clear(ctx); await scheduler.stopRun(item); return taskCard(ctx, item); }
      if (a.type === "task-delete") {
        if (scheduler.busy(item)) throw new Error(t("busy"));
        delete state.tasks[item.id]; delete r.state.chats[taskChatKey(item.id)]; r.threadCache.delete(taskChatKey(item.id));
        await ui.clear(ctx); return taskList(ctx);
      }
      if (a.type === "task-edit") {
        if (scheduler.busy(item)) throw new Error(t("busy"));
        const draft = JSON.parse(JSON.stringify(item));
        if (a.field === "schedule") return chooseSchedule(ctx, draft);
        if (a.field === "project") return chooseTaskProject(ctx, draft, true);
        return ui.ask(ctx, t(a.field), { stage: `task-${a.field}`, draft, editing: true }, a.field === "prompt" ? t("promptHint") : "");
      }
    }
    if (a.type === "mcp") return mcpList(ctx, a.accountId, a.health, a.page);
    if (a.type === "mcp-reload") {
      assertAdmin(ctx); const id = a.accountId || currentAccount(ctx); assertAccountIdle(id);
      for (const key of r.threadCache.keys()) if (selectedAccountId(r.getChatState(key)) === id) r.threadCache.delete(key);
      return mcpList(ctx, id, true);
    }
    if (a.type === "mcp-server") {
      assertAdmin(ctx);
      return ui.show(ctx, `${b(a.server.name)}\n${t(a.server.status)}\n${code(safe(a.server.error || ""))}\n${t("mcpConfirm")}\n\n${t("mcpHint")}`, [
        ...(a.server.plugin ? [] : [[btn(t(a.server.enabled ? "disable" : "enable"), "mcp-set", { ...a, type: "mcp-set", enabled: !a.server.enabled })]]),
        [btn(t("back"), "mcp", { accountId: a.accountId })]
      ]);
    }
    if (a.type === "mcp-set") {
      assertAdmin(ctx); assertAccountIdle(a.accountId); await ui.clear(ctx);
      const release = await accounts.acquire(a.accountId);
      try { await backend.setMcpEnabled(a.accountId, a.cwd, a.server.name, a.enabled, a.version); }
      finally { await release(); }
      for (const key of r.threadCache.keys()) if (selectedAccountId(r.getChatState(key)) === a.accountId) r.threadCache.delete(key);
      return mcpList(ctx, a.accountId);
    }
    if (a.type === "dashboard") return dashboardMenu(ctx);
    if (a.type === "hide") {
      state.panelPreferences[destinationKey(meta(ctx))] = false;
      await ui.clear(ctx); await dashboard.tick(); return;
    }
    if (a.type === "dashboard-toggle") {
      const key = destinationKey(meta(ctx)); state.panelPreferences[key] = state.panelPreferences[key] === false;
      await ui.clear(ctx); await dashboard.tick(); return dashboardMenu(ctx);
    }
    if (a.type === "stop") {
      for (const [key, active] of dashboard.activeFor(meta(ctx))) {
        active.stopRequested = true; active.abortController?.abort();
        if (active.workerJobId) await r.cancelWorkerJobOnce(active, active.workerJobId);
        const item = Object.values(state.tasks).find((x) => taskChatKey(x.id) === key && x.owner === scopeKey(ctx));
        if (item) await scheduler.stopRun(item);
      }
      return dashboardMenu(ctx);
    }
    throw new Error(t("expired"));
  }
  async function watchTick() {
    if (watching) return;
    watching = true;
    try {
      for (const flow of Object.values(state.flows)) {
        if (flow.data.kind !== "watch" || flow.expiresAt <= now()) continue;
        if (flow.botId !== r.bot.botInfo?.id || !authorizeTelegramUpdate({ from: { id: flow.userId }, chat: { id: flow.chatId },
          message: { message_thread_id: flow.messageThreadId } }, r.config).ok) continue;
        try {
          const { html } = await sessionHtml(flow.data.accountId, flow.data.session);
          const output = `${html}\n\n${t("watchHint")}`;
          if (output === flow.html) continue;
          await editOrReplyTelegramHtml({ editMessageText: (html, extra) => r.bot.telegram.editMessageText(flow.chatId, flow.messageId, undefined, html, extra) },
            output, { reply_markup: flow.markup }, { replyOnUnavailable: false });
          flow.html = output;
        } catch { /* Deleted logs/messages do not interrupt ordinary bot traffic. */ }
      }
    } finally { watching = false; }
  }
  forum.registerCommands();
  for (const command of ["projects", "sessions", "tasks", "dashboard", "mcp"]) {
    r.bot.command(command, (ctx) => ui.guard(ctx, () => action(ctx, { type: command })));
  }
  r.bot.command("newtask", (ctx) => ui.guard(ctx, () => action(ctx, { type: "task-new" })));
  r.bot.command("cancel", (ctx) => ui.guard(ctx, () => ui.close(ctx)));
  r.bot.action(/^w:(projects|sessions|tasks|dashboard|mcp|stop|hide)$/, (ctx) => ui.guard(ctx, () => action(ctx, { type: ctx.match[1] })));
  ui.register(action, onInput);
  forum.registerMessages();
  return {
    scheduler, dashboard, ui, forum,
    start() {
      if (timer) return;
      stopped = false;
      timer = timers.setInterval(() => {
        if (stopped) return;
        for (const work of [scheduler.tick, dashboard.tick, watchTick, forum.jobs.tick]) work().catch((e) => console.warn("Workspace service:", safe(e.message)));
      }, 10_000);
      timer.unref?.();
    },
    stop() { stopped = true; timers.clearInterval(timer); timer = null; }
  };
}
