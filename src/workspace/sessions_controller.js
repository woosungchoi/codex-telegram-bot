// @ts-check
import { b, code, escapeHtml } from "../telegram/html.js";
import { editOrReplyTelegramHtml } from "../telegram/api.js";
import { authorizeTelegramUpdate } from "../security.js";
import { accountConfig, rememberAccountThread } from "../accounts/context.js";
import { sessionButtonLabel, sessionTitle } from "./session_labels.js";
import { assertTopicDirectory } from "../forum/store.js";
import { clip } from "./presentation.js";

/** @param {import("./contracts.js").SessionsServices} services */
export function createSessionsController({
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
}) {
  async function sessionList(ctx, args = {}) {
    const accountId = args.accountId || currentAccount(ctx);
    const account = await accounts.get(accountId);
    const scope = args.scope === "all" ? "all" : "project";
    const cwd =
      scope === "all"
        ? null
        : args.cwd || chats.options(chats.key(ctx)).workingDirectory;
    const view = {
      accountId,
      scope,
      cwd,
      query: args.query || "",
      cursor: args.cursor || null,
      cursors: args.cursors || [],
    };
    const firstPage = { ...view, cursor: null, cursors: [] };
    const result = await backend.listSessions(accountId, {
      cwd,
      query: view.query,
      cursor: view.cursor,
    });
    const timeZone =
      settings.ui?.timeZone || settings.config.telegramTimeZone || "UTC";
    const rows = (result.data || []).map((s) => [
      btn(
        sessionButtonLabel(
          { ...s, cwd: safe(s.cwd || "") },
          safe(sessionTitle(s) || t("untitledSession")),
          { timeZone, showFolder: scope === "all" },
        ),
        "session",
        { accountId, session: s, view },
      ),
    ]);
    const cursors = view.cursors;
    const paging = [];
    if (cursors.length)
      paging.push(
        btn("←", "sessions", {
          ...view,
          cursor: cursors.at(-1),
          cursors: cursors.slice(0, -1),
        }),
      );
    if (result.nextCursor)
      paging.push(
        btn("→", "sessions", {
          ...view,
          cursor: result.nextCursor,
          cursors: [...cursors, view.cursor],
        }),
      );
    if (paging.length) rows.push(paging);
    rows.push([
      btn(
        `${scope === "project" ? "✅ " : ""}${t("sessionProject")}`,
        "sessions",
        { ...firstPage, scope: "project", cwd: null },
      ),
      btn(`${scope === "all" ? "✅ " : ""}${t("sessionAll")}`, "sessions", {
        ...firstPage,
        scope: "all",
        cwd: null,
      }),
    ]);
    rows.push([
      btn(t("search"), "session-search", { view: firstPage }),
      btn(t("refresh"), "sessions", firstPage),
    ]);
    if (view.query)
      rows.push([
        btn(t("clearSearch"), "sessions", { ...firstPage, query: "" }),
      ]);
    rows.push(
      ...(await accounts.list()).map((a) => [
        btn(`${a.id === accountId ? "✅ " : ""}${a.label}`, "sessions", {
          ...firstPage,
          accountId: a.id,
        }),
      ]),
    );
    return ui.show(
      ctx,
      [
        b(t("sessions")),
        `${t("account")}: ${b(account.label)}`,
        b(t(scope === "all" ? "sessionAll" : "sessionProject")),
        cwd ? code(safe(cwd)) : t("sessionAllHint"),
        t("sessionLabelHint"),
        view.query ? code(safe(view.query)) : "",
        result.data?.length ? "" : t("empty"),
      ].join("\n"),
      rows,
    );
  }

  async function sessionHtml(accountId, session) {
    const tail = await readTail(
      session.path,
      accountConfig(settings.config, accountId).codexSessionsDir,
    );
    const lines = [
      b(t("sessions")),
      code(session.id),
      code(clip(session.cwd, 600)),
      `${date(session.updatedAt * 1000)} · ${t(tail.activity)}`,
      "",
      b(t("preview")),
      escapeHtml(safe(sessionTitle(session) || t("untitledSession"))),
    ];
    for (const m of tail.messages)
      lines.push("", b(m.role), escapeHtml(safe(m.text).slice(-400)));
    return { html: lines.join("\n"), activity: tail.activity };
  }

  async function sessionCard(
    ctx,
    accountId,
    listed,
    watch = false,
    view = { accountId },
  ) {
    await accounts.get(accountId);
    const session = await backend.readSession(accountId, listed.id);
    const { html } = await sessionHtml(accountId, session);
    return ui.show(
      ctx,
      html + (watch ? `\n\n${t("watchHint")}` : ""),
      [
        [
          btn(t("resume"), "session-resume", { accountId, session }),
          btn(
            t(watch ? "stopWatch" : "watch"),
            watch ? "session" : "session-watch",
            { accountId, session, view },
          ),
        ],
        [ui.back("sessions", view)],
      ],
      { kind: watch ? "watch" : "session", accountId, session },
    );
  }

  async function action(ctx, a) {
    if (a.type === "sessions") return sessionList(ctx, a);
    if (a.type === "session" || a.type === "session-watch")
      return sessionCard(
        ctx,
        a.accountId,
        a.session,
        a.type === "session-watch",
        a.view,
      );
    if (a.type === "session-search")
      return ui.ask(
        ctx,
        t("search"),
        { stage: a.type, view: a.view || { accountId: a.accountId } },
        t("searchPrompt"),
      );
    if (a.type === "session-resume") {
      assertIdle(ctx);
      await readyAccount(a.accountId);
      const session = await backend.readSession(a.accountId, a.session.id);
      await validateDirectory(session.cwd);
      const tail = await readTail(
        session.path,
        accountConfig(settings.config, a.accountId).codexSessionsDir,
        { maxBytes: 4 * 1024 * 1024 },
      );
      if (tail.activity === "running" || session.status?.type === "active")
        throw new Error(t("busy"));
      for (const key of execution.active.keys()) {
        const c = chats.get(key);
        if (
          c.threadId === session.id ||
          c.accountAttemptState?.threadId === session.id
        )
          throw new Error(t("busy"));
      }
      assertIdle(ctx);
      const key = chats.key(ctx),
        chat = chats.get(key);
      assertTopicDirectory(chat, await validateDirectory(session.cwd));
      chat.accountId = a.accountId;
      chat.options.workingDirectory = session.cwd;
      rememberAccountThread(chat, session.id, a.accountId);
      chats.cache.delete(key);
      await ui.clear(ctx);
      return ui.show(
        ctx,
        `${b(t("resumed"))}\n${code(session.id)}\n${code(session.cwd)}`,
        [nav("sessions")],
      );
    }
    throw new Error(t("expired"));
  }

  async function onInput(ctx, value, data) {
    if (data.stage === "session-search")
      return sessionList(ctx, {
        ...(data.view || { accountId: data.accountId }),
        query: clip(value, 100),
        cursor: null,
        cursors: [],
      });
    throw new Error(t("expired"));
  }

  let watching = false;
  async function watchTick() {
    if (watching) return;
    watching = true;
    try {
      for (const flow of Object.values(state.flows)) {
        if (flow.data.kind !== "watch" || flow.expiresAt <= now()) continue;
        if (
          flow.botId !== telegram.bot.botInfo?.id ||
          !authorizeTelegramUpdate(
            {
              from: { id: flow.userId },
              chat: { id: flow.chatId },
              message: { message_thread_id: flow.messageThreadId },
            },
            settings.config,
          ).ok
        )
          continue;
        try {
          const { html } = await sessionHtml(
            flow.data.accountId,
            flow.data.session,
          );
          const output = `${html}\n\n${t("watchHint")}`;
          if (output === flow.html) continue;
          await editOrReplyTelegramHtml(
            {
              editMessageText: (html, extra) =>
                telegram.bot.telegram.editMessageText(
                  flow.chatId,
                  flow.messageId,
                  undefined,
                  html,
                  extra,
                ),
            },
            output,
            { reply_markup: flow.markup },
            { replyOnUnavailable: false },
          );
          flow.html = output;
        } catch {
          /* Deleted logs/messages do not interrupt ordinary bot traffic. */
        }
      }
    } finally {
      watching = false;
    }
  }
  return { action, onInput, watchTick };
}
