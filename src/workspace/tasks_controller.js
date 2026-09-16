import { LocalizedError } from "../i18n.js";
// @ts-check
import { b, code, escapeHtml } from "../telegram/html.js";
import { taskChatKey } from "./scheduler.js";
import { cleanName, newId, scopeKey } from "./store.js";
import { nextOccurrence, parseSchedule, scheduleLabel } from "./schedule.js";
import { clip } from "./presentation.js";

/** @param {import("./contracts.js").TasksServices} services */
export function createTasksController({
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
}) {
  async function taskList(ctx) {
    const list = Object.values(state.tasks).filter(
      (item) => item.owner === scopeKey(ctx),
    );
    const rows = list.map((item) => [
      btn(`${item.enabled ? "▶" : "⏸"} ${item.name}`, "task", { id: item.id }),
    ]);
    rows.push([btn(t("addTask"), "task-new"), btn(t("refresh"), "tasks")]);
    return ui.show(
      ctx,
      `${b(t("tasks"))}\n${list.length ? `${list.length} / 20` : t("empty")}`,
      rows,
    );
  }

  async function taskHtml(item) {
    const account = await accounts
      .get(item.accountId)
      .catch(() => ({ label: item.accountId }));
    return [
      b(item.name),
      code(item.options.workingDirectory),
      `${t("account")}: ${b(account.label)}`,
      `${t("model")}: ${code(item.options.model || "default")}`,
      code(
        scheduleLabel(item.schedule, (key) =>
          t(key.slice("workspace.".length)),
        ),
      ),
      `${t("nextRun")}: ${code(date(item.nextAt))}`,
      "",
      escapeHtml(clip(item.prompt, 1000)),
    ].join("\n");
  }

  async function taskCard(ctx, item) {
    await scheduler.reconcile(item);
    const history = [...(item.history || []), ...(item.run ? [item.run] : [])]
      .slice(-5)
      .map((run) => `${date(run.startedAt)} · ${t(run.status)}`)
      .join("\n");
    return ui.show(
      ctx,
      `${b(t("tasks"))}\n${t(item.enabled ? "enabled" : "disabled")}\n${await taskHtml(item)}\n\n${b(t("history"))}\n${escapeHtml(history || "—")}${item.error ? `\n${code(item.error)}` : ""}`,
      [
        [
          btn(t("runNow"), "task-run-confirm", { id: item.id }),
          btn(t(item.enabled ? "disable" : "enable"), "task-toggle", {
            id: item.id,
          }),
        ],
        [
          btn(t("rename"), "task-edit", { id: item.id, field: "name" }),
          btn(t("editPrompt"), "task-edit", { id: item.id, field: "prompt" }),
        ],
        [
          btn(t("editSchedule"), "task-edit", {
            id: item.id,
            field: "schedule",
          }),
          btn(t("editProject"), "task-edit", { id: item.id, field: "project" }),
        ],
        [
          btn(t("stop"), "task-stop-confirm", { id: item.id }),
          btn(t("remove"), "task-remove", { id: item.id }),
        ],
        nav("tasks"),
      ],
    );
  }

  function snapshotForTask(ctx, preset = currentPreset(ctx)) {
    return {
      projectName: preset.name || preset.cwd,
      accountId: preset.accountId,
      options: {
        ...chats.options(chats.key(ctx)),
        ...preset.options,
        workingDirectory: preset.cwd,
      },
    };
  }

  async function chooseTaskProject(ctx, draft, editing = false) {
    const choices = [
      [
        btn(t("currentProject"), "task-project", {
          draft,
          editing,
          preset: currentPreset(ctx),
        }),
      ],
      ...projects(ctx).map((p) => [
        btn(p.name, "task-project", { draft, editing, preset: p }),
      ]),
      nav("tasks"),
    ];
    return ui.show(
      ctx,
      `${b(t("chooseProject"))}\n${escapeHtml(draft.name)}`,
      choices,
    );
  }

  async function chooseSchedule(ctx, draft) {
    return ui.show(
      ctx,
      `${b(t("schedule"))}\n${code(settings.ui?.timeZone || settings.config.telegramTimeZone || "UTC")}`,
      [
        ...["once", "daily", "weekly", "monthly", "interval"].map((kind) => [
          btn(t(kind), "task-schedule", { draft, kind }),
        ]),
        nav("tasks"),
      ],
    );
  }

  async function confirmTask(ctx, draft) {
    return ui.show(ctx, `${b(t("confirmTask"))}\n\n${await taskHtml(draft)}`, [
      [btn(t("save"), "task-save", { draft })],
      nav("tasks"),
    ]);
  }

  async function action(ctx, a) {
    if (a.type === "tasks") return taskList(ctx);
    if (a.type === "task") return taskCard(ctx, task(ctx, a.id));
    if (a.type === "task-new")
      return ui.ask(ctx, t("name"), {
        stage: "task-name",
        draft: { id: newId() },
      });
    if (a.type === "task-project") {
      const draft = { ...a.draft, ...snapshotForTask(ctx, a.preset) };
      return a.editing ? confirmTask(ctx, draft) : chooseSchedule(ctx, draft);
    }
    if (a.type === "task-schedule")
      return ui.ask(
        ctx,
        t(a.kind),
        {
          stage: "task-time",
          kind: a.kind,
          draft: a.draft,
          timeZone:
            settings.ui?.timeZone || settings.config.telegramTimeZone || "UTC",
        },
        t("scheduleHint"),
      );
    if (a.type === "task-save") {
      const existing = state.tasks[a.draft.id];
      if (existing && task(ctx, a.draft.id) && scheduler.busy(existing))
        throw new Error(t("busy"));
      if (
        !existing &&
        Object.values(state.tasks).filter((v) => v.owner === scopeKey(ctx))
          .length >= 20
      )
        throw new LocalizedError(
          "errors.atMost20ScheduledTasksPerUserChatTopic",
        );
      await readyAccount(a.draft.accountId);
      await validateDirectory(a.draft.options.workingDirectory);
      if (existing && scheduler.busy(existing)) throw new Error(t("busy"));
      const nextAt =
        existing &&
        JSON.stringify(existing.schedule) === JSON.stringify(a.draft.schedule)
          ? existing.nextAt
          : nextOccurrence(a.draft.schedule, now());
      if (!nextAt && (!existing || existing.enabled))
        throw new LocalizedError("errors.chooseAFutureSchedule");
      const saved = {
        ...existing,
        ...a.draft,
        owner: scopeKey(ctx),
        userId: String(ctx.from.id),
        destination: meta(ctx),
        enabled: existing?.enabled ?? true,
        nextAt,
        run: existing?.run,
        history: existing?.history || [],
      };
      state.tasks[saved.id] = saved;
      await ui.clear(ctx);
      return taskCard(ctx, saved);
    }
    if (a.type.startsWith("task-")) {
      const item = task(ctx, a.id);
      if (a.type === "task-toggle") {
        if (!item.enabled) {
          item.nextAt = nextOccurrence(item.schedule, now());
          if (!item.nextAt)
            throw new LocalizedError("errors.chooseAFutureSchedule");
        }
        item.enabled = !item.enabled;
        delete item.error;
        await ui.clear(ctx);
        return taskCard(ctx, item);
      }
      if (
        ["task-run-confirm", "task-stop-confirm", "task-remove"].includes(
          a.type,
        )
      ) {
        const next = {
          "task-run-confirm": "task-run",
          "task-stop-confirm": "task-stop",
          "task-remove": "task-delete",
        }[a.type];
        return ui.show(
          ctx,
          `${b(t(a.type === "task-run-confirm" ? "runConfirm" : a.type === "task-remove" ? "removeHint" : "stop"))}\n\n${await taskHtml(item)}`,
          [
            [btn(t("confirm"), next, { id: item.id })],
            [ui.back("task", { id: item.id })],
          ],
        );
      }
      if (a.type === "task-run") {
        await ui.clear(ctx);
        await scheduler.run(item, { manual: true });
        return taskCard(ctx, item);
      }
      if (a.type === "task-stop") {
        await ui.clear(ctx);
        await scheduler.stopRun(item);
        return taskCard(ctx, item);
      }
      if (a.type === "task-delete") {
        if (scheduler.busy(item)) throw new Error(t("busy"));
        delete state.tasks[item.id];
        delete chats.all[taskChatKey(item.id)];
        chats.cache.delete(taskChatKey(item.id));
        await ui.clear(ctx);
        return taskList(ctx);
      }
      if (a.type === "task-edit") {
        if (scheduler.busy(item)) throw new Error(t("busy"));
        const draft = JSON.parse(JSON.stringify(item));
        if (a.field === "schedule") return chooseSchedule(ctx, draft);
        if (a.field === "project") return chooseTaskProject(ctx, draft, true);
        return ui.ask(
          ctx,
          t(a.field),
          { stage: `task-${a.field}`, draft, editing: true },
          a.field === "prompt" ? t("promptHint") : "",
        );
      }
    }
    throw new Error(t("expired"));
  }

  async function onInput(ctx, value, data) {
    if (data.stage === "task-name") {
      const draft = { ...data.draft, name: cleanName(value) };
      if (data.editing) return confirmTask(ctx, draft);
      return ui.ask(
        ctx,
        t("prompt"),
        { stage: "task-prompt", draft },
        t("promptHint"),
      );
    }
    if (data.stage === "task-prompt") {
      if (value.length > 8000) throw new Error(t("promptHint"));
      const draft = { ...data.draft, prompt: value };
      return data.editing
        ? confirmTask(ctx, draft)
        : chooseTaskProject(ctx, draft);
    }
    if (data.stage === "task-time") {
      const schedule = parseSchedule(data.kind, value, data.timeZone, now());
      return confirmTask(ctx, {
        ...data.draft,
        schedule,
        nextAt: nextOccurrence(schedule, now()),
      });
    }
    throw new Error(t("expired"));
  }
  return { action, onInput };
}
