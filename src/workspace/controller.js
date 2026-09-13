// @ts-check
import { clip } from "./presentation.js";
import { createWorkspaceCapabilities } from "./capabilities.js";
import { createDashboardController } from "./dashboard_controller.js";
import { createMcpController } from "./mcp_controller.js";
import { createTasksController } from "./tasks_controller.js";
import { createSessionsController } from "./sessions_controller.js";
import { createProjectsController } from "./projects_controller.js";

import { createAccountStore } from "../accounts/store.js";
import { selectedAccountId } from "../accounts/context.js";
import { createWorkspaceBackend, readSessionTail } from "./backend.js";

import { createTaskScheduler } from "./scheduler.js";
import { createTaskDashboard } from "./dashboard.js";
import { createWorkspaceUi } from "./ui.js";
import { workspaceText } from "./messages.js";
import {
  browseFolders,
  directory,
  projectOptions,
  scopeKey,
  topicId,
  workspaceState,
} from "./store.js";

import { createForumMenus } from "../forum/controller.js";

import { isRegisteredTelegramCommandText } from "../telegram_commands.js";

export function registerWorkspaceFlowBoundary(r) {
  r.bot.use(async (ctx, next) => {
    const data = ctx.callbackQuery?.data;
    if (
      isRegisteredTelegramCommandText(ctx.message) ||
      (data && !data.startsWith("ws:"))
    ) {
      const flows = workspaceState(r.state).flows;
      if (ctx.chat && ctx.from && flows[scopeKey(ctx)]) {
        delete flows[scopeKey(ctx)];
        await r.saveState();
      }
    }
    return next();
  });
}

export function registerWorkspaceMenus(
  r,
  {
    accounts = createAccountStore(r.config),
    backend = createWorkspaceBackend(r.config),
    readTail = readSessionTail,
    browse = browseFolders,
    validateDirectory = directory,
    now = Date.now,
    timers = { setInterval, clearInterval },
  } = {},
) {
  const state = workspaceState(r.state);
  const t = (key) =>
    workspaceText(r.state.ui?.language || r.config.telegramLanguage, key);
  const { chats, execution, settings, telegram } =
    createWorkspaceCapabilities(r);
  const ui = createWorkspaceUi(r, t, { now });
  const btn = ui.button;
  const scheduler = createTaskScheduler(r, { accounts, now });
  const dashboard = createTaskDashboard(r, { accounts, text: t, now });
  const forum = createForumMenus(r, { ui, accounts, text: t, now });
  let timer,
    stopped = false;
  const safe = (s) => clip(r.redactText?.(s) || s, 1600);
  const meta = (ctx) => ({
    chatId: ctx.chat.id,
    chatType: ctx.chat.type,
    messageThreadId: topicId(ctx),
    chatKey: r.getChatKey(ctx),
    botId: r.bot.botInfo.id,
  });
  const projects = (ctx) => (state.projects[scopeKey(ctx)] ||= []);
  const project = (ctx, id) => {
    const p = projects(ctx).find((v) => v.id === id);
    if (!p) throw new Error(t("expired"));
    return p;
  };
  const task = (ctx, id) => {
    const item = state.tasks[id];
    if (!item || item.owner !== scopeKey(ctx)) throw new Error(t("expired"));
    return item;
  };
  const date = (at) =>
    at ? r.formatDateTime?.(at) || new Date(at).toISOString() : "—";
  const currentAccount = (ctx) =>
    selectedAccountId(r.getChatState(r.getChatKey(ctx)));
  const nav = (type) => [ui.back(type)];

  function assertIdle(ctx) {
    const key = r.getChatKey(ctx);
    if (
      r.activeTurns.has(key) ||
      r.getSideTurnCount(key) ||
      r.getPendingTurns(key).length ||
      r.hasPendingFinalDelivery(key)
    )
      throw new Error(t("busy"));
  }
  function assertAdmin(ctx) {
    if (
      ctx.chat.type !== "private" ||
      !r.config.codexAccountAdminUserIds?.has(String(ctx.from.id))
    )
      throw new Error(t("admin"));
  }
  function assertAccountIdle(id) {
    for (const [key, a] of r.activeTurns) {
      const c = r.getChatState(key);
      if (
        (c.accountAttemptState?.accountId ||
          c.threadAccountId ||
          c.accountId ||
          "default") === id ||
        a.currentPreparedTurn?.accountId === id
      )
        throw new Error(t("busy"));
    }
    for (const key of Object.keys(r.state.chats || {})) {
      if (
        selectedAccountId(r.getChatState(key)) === id &&
        r.getSideTurnCount(key)
      )
        throw new Error(t("busy"));
    }
  }
  async function readyAccount(id) {
    const a = await accounts.get(id);
    if (a.status !== "ready")
      throw new Error("The selected account needs sign-in. Open /accounts.");
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
    return {
      cwd: cwd || options.workingDirectory,
      accountId: currentAccount(ctx),
      options: {
        ...projectOptions(options),
        workingDirectory: cwd || options.workingDirectory,
      },
    };
  }
  const projectsController = createProjectsController({
    accounts,
    assertIdle,
    browse,
    btn,
    chats,
    currentPreset,
    nav,
    now,
    project,
    projects,
    readyAccount,
    resetThread,
    state,
    t,
    ui,
    validateDirectory,
  });
  const sessionsController = createSessionsController({
    accounts,
    assertIdle,
    backend,
    btn,
    chats,
    currentAccount,
    date,
    execution,
    nav,
    now,
    readTail,
    readyAccount,
    safe,
    settings,
    state,
    t,
    telegram,
    ui,
    validateDirectory,
  });
  const tasksController = createTasksController({
    accounts,
    btn,
    chats,
    currentPreset,
    date,
    meta,
    nav,
    now,
    projects,
    readyAccount,
    scheduler,
    settings,
    state,
    t,
    task,
    ui,
    validateDirectory,
  });
  const mcpController = createMcpController({
    accounts,
    assertAccountIdle,
    assertAdmin,
    backend,
    btn,
    chats,
    currentAccount,
    safe,
    t,
    ui,
  });
  const dashboardController = createDashboardController({
    btn,
    dashboard,
    execution,
    meta,
    scheduler,
    state,
    t,
    ui,
  });
  const controllers = {
    projects: projectsController,
    sessions: sessionsController,
    tasks: tasksController,
    mcp: mcpController,
    dashboard: dashboardController,
  };
  const domainFor = (kind) => {
    const prefix = String(kind).split("-")[0];
    return (
      {
        project: "projects",
        browse: "projects",
        session: "sessions",
        task: "tasks",
        hide: "dashboard",
        stop: "dashboard",
      }[prefix] || prefix
    );
  };
  async function onInput(ctx, value, data) {
    if (data.stage?.startsWith("forum-"))
      return forum.onInput(ctx, value, data);
    const controller = controllers[domainFor(data.stage)];
    if (!controller?.onInput) throw new Error(t("expired"));
    return controller.onInput(ctx, value, data);
  }
  async function action(ctx, a) {
    if (a.type === "forum" || a.type.startsWith("forum-"))
      return forum.action(ctx, a);
    if (a.type === "close") return ui.close(ctx);
    if (a.type === "home") {
      await ui.clear(ctx);
      return r.sendPanel(ctx, a.panel === "tools" ? "tools" : "main", {
        edit: true,
      });
    }
    const controller = controllers[domainFor(a.type)];
    if (!controller) throw new Error(t("expired"));
    return controller.action(ctx, a);
  }
  forum.registerCommands();
  for (const command of ["projects", "sessions", "tasks", "dashboard", "mcp"]) {
    r.bot.command(command, (ctx) =>
      ui.guard(ctx, () => action(ctx, { type: command })),
    );
  }
  r.bot.command("newtask", (ctx) =>
    ui.guard(ctx, () => action(ctx, { type: "task-new" })),
  );
  r.bot.command("cancel", (ctx) => ui.guard(ctx, () => ui.close(ctx)));
  r.bot.action(
    /^w:(projects|sessions|tasks|dashboard|mcp|stop|hide)(?::(tools))?$/,
    (ctx) =>
      ui.guard(ctx, () => {
        ctx.state.workspaceParentPanel = ctx.match[2];
        return action(ctx, { type: ctx.match[1] });
      }),
  );
  ui.register(action, onInput);
  forum.registerMessages();
  return {
    scheduler,
    dashboard,
    ui,
    forum,
    start() {
      if (timer) return;
      stopped = false;
      timer = timers.setInterval(() => {
        if (stopped) return;
        for (const work of [
          scheduler.tick,
          dashboard.tick,
          sessionsController.watchTick,
          forum.jobs.tick,
        ])
          work().catch((e) =>
            console.warn("Workspace service:", safe(e.message)),
          );
      }, 10_000);
      timer.unref?.();
    },
    stop() {
      stopped = true;
      timers.clearInterval(timer);
      timer = null;
    },
  };
}
