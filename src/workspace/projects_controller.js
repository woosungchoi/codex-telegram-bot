// @ts-check
import { b, code } from "../telegram/html.js";
import { cleanName, newId, scopeKey, sortedProjects } from "./store.js";
import { assertTopicDirectory } from "../forum/store.js";
import { clip } from "./presentation.js";
const PAGE = 8;

/** @param {import("./contracts.js").ProjectsServices} services */
export function createProjectsController({
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
}) {
  async function projectList(ctx, query = "", page = 0) {
    const list = sortedProjects(projects(ctx), query);
    const start =
      Math.max(
        0,
        Math.min(page, Math.max(0, Math.ceil(list.length / PAGE) - 1)),
      ) * PAGE;
    const rows = list
      .slice(start, start + PAGE)
      .map((p) => [
        btn(`${p.favorite ? "⭐" : "📁"} ${p.name}`, "project", { id: p.id }),
      ]);
    const paging = [];
    if (start)
      paging.push(btn("←", "projects", { query, page: start / PAGE - 1 }));
    if (start + PAGE < list.length)
      paging.push(btn("→", "projects", { query, page: start / PAGE + 1 }));
    if (paging.length) rows.push(paging);
    rows.push(
      [btn(t("saveCurrent"), "project-save"), btn(t("browse"), "browse")],
      [btn(t("path"), "project-path"), btn(t("search"), "project-search")],
    );
    if (query) rows.push([btn(t("clearSearch"), "projects")]);
    return ui.show(
      ctx,
      `${b(t("projects"))}\n${query ? code(query) : ""}\n${list.length ? `${start + 1}–${Math.min(start + PAGE, list.length)} / ${list.length}` : t("empty")}`,
      rows,
    );
  }

  async function projectCard(ctx, p, notice = "") {
    const account = await accounts
      .get(p.accountId)
      .catch(() => ({ label: p.accountId }));
    return ui.show(
      ctx,
      [
        b(t("projects")),
        notice,
        b(p.name),
        code(p.cwd),
        `${t("account")}: ${b(account.label)}`,
        `${t("model")}: ${code(p.options.model || "default")} · ${code(p.options.modelReasoningEffort || "default")}`,
      ].join("\n"),
      [
        [
          btn(t("open"), "project-open", { id: p.id }),
          btn(t("favorite"), "project-favorite", { id: p.id }),
        ],
        [btn(t("capture"), "project-capture", { id: p.id })],
        [
          btn(t("rename"), "project-rename", { id: p.id }),
          btn(t("remove"), "project-remove", { id: p.id }),
        ],
        nav("projects"),
      ],
    );
  }

  async function folderList(ctx, cwd, page = 0) {
    const listing = await browse(
      cwd || chats.options(chats.key(ctx)).workingDirectory,
    );
    const start = Math.max(0, page) * PAGE;
    const rows = listing.folders
      .slice(start, start + PAGE)
      .map((p) => [btn(`📂 ${p.name}`, "browse", { cwd: p.cwd })]);
    const paging = [];
    if (page)
      paging.push(btn("←", "browse", { cwd: listing.cwd, page: page - 1 }));
    if (start + PAGE < listing.folders.length)
      paging.push(btn("→", "browse", { cwd: listing.cwd, page: page + 1 }));
    if (paging.length) rows.push(paging);
    rows.push(
      [btn(t("chooseFolder"), "project-save", { cwd: listing.cwd })],
      [
        btn(t("parent"), "browse", { cwd: listing.parent }),
        btn(t("path"), "project-path"),
      ],
      nav("projects"),
    );
    return ui.show(
      ctx,
      `${b(t("browse"))}\n${code(listing.cwd)}${listing.capped ? `\n${t("capped")}` : ""}`,
      rows,
    );
  }

  async function action(ctx, a) {
    if (a.type === "projects") return projectList(ctx, a.query, a.page);
    if (a.type === "project") return projectCard(ctx, project(ctx, a.id));
    if (a.type === "browse") return folderList(ctx, a.cwd, a.page);
    if (a.type === "project-path")
      return ui.ask(ctx, t("path"), { stage: a.type }, t("pathPrompt"));
    if (a.type === "project-search")
      return ui.ask(ctx, t("search"), { stage: a.type }, t("searchPrompt"));
    if (a.type === "project-save")
      return ui.ask(ctx, t("name"), {
        stage: "project-name",
        preset: currentPreset(ctx, a.cwd),
      });
    if (a.type.startsWith("project-")) {
      const p = project(ctx, a.id);
      if (a.type === "project-open") {
        assertIdle(ctx);
        await readyAccount(p.accountId);
        await validateDirectory(p.cwd);
        assertIdle(ctx);
        const chat = chats.get(chats.key(ctx));
        assertTopicDirectory(chat, p.cwd);
        for (const key of ["model", "modelReasoningEffort", "serviceTier"])
          delete chat.options[key];
        Object.assign(chat.options, p.options, { workingDirectory: p.cwd });
        chat.accountId = p.accountId;
        resetThread(chat, p.accountId);
        p.lastUsedAt = now();
        chats.cache.delete(chats.key(ctx));
        await ui.clear(ctx);
        return projectCard(ctx, p, t("projectOpened"));
      }
      if (a.type === "project-favorite") p.favorite = !p.favorite;
      if (a.type === "project-capture") {
        const snapshot = currentPreset(ctx, p.cwd);
        p.accountId = snapshot.accountId;
        p.options = snapshot.options;
      }
      if (a.type === "project-rename")
        return ui.ask(ctx, t("name"), { stage: a.type, id: p.id });
      if (a.type === "project-remove")
        return ui.show(ctx, `${b(p.name)}\n${t("removeHint")}`, [
          [btn(t("confirm"), "project-delete", { id: p.id })],
          nav("projects"),
        ]);
      if (a.type === "project-delete") {
        state.projects[scopeKey(ctx)] = projects(ctx).filter(
          (x) => x.id !== p.id,
        );
        await ui.clear(ctx);
        return projectList(ctx);
      }
      await ui.clear(ctx);
      return projectCard(ctx, p, t("saved"));
    }
    throw new Error(t("expired"));
  }

  async function onInput(ctx, value, data) {
    if (data.stage === "project-search")
      return projectList(ctx, clip(value, 100));
    if (data.stage === "project-path")
      return folderList(ctx, await validateDirectory(value));
    if (data.stage === "project-name") {
      const name = cleanName(value);
      const list = projects(ctx);
      if (list.length >= 60)
        throw new Error("At most 60 saved projects per user/chat/topic.");
      const cwd = await validateDirectory(data.preset.cwd);
      const p = {
        ...data.preset,
        cwd,
        name,
        id: newId(),
        favorite: false,
        lastUsedAt: now(),
      };
      list.push(p);
      await ui.clear(ctx);
      return projectCard(ctx, p, t("saved"));
    }
    if (data.stage === "project-rename") {
      const p = project(ctx, data.id);
      p.name = cleanName(value);
      await ui.clear(ctx);
      return projectCard(ctx, p, t("saved"));
    }
    throw new Error(t("expired"));
  }
  return { action, onInput };
}
