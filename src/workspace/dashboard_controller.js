// @ts-check
import { taskChatKey } from "./scheduler.js";
import { destinationKey, scopeKey } from "./store.js";

/** @param {import("./contracts.js").DashboardServices} services */
export function createDashboardController({
  btn,
  dashboard,
  execution,
  meta,
  scheduler,
  state,
  t,
  ui,
}) {
  async function dashboardMenu(ctx) {
    const dest = meta(ctx);
    const on = state.panelPreferences[destinationKey(dest)] !== false;
    return ui.show(
      ctx,
      `${await dashboard.describe(dest)}\n\n${t("autoPanel")}: ${t(on ? "enabled" : "disabled")}`,
      [
        [
          btn(t(on ? "disable" : "enable"), "dashboard-toggle"),
          btn(t("refresh"), "dashboard"),
        ],
        [btn(t("stop"), "stop"), btn(t("tasks"), "tasks")],
      ],
    );
  }

  async function action(ctx, a) {
    if (a.type === "dashboard") return dashboardMenu(ctx);
    if (a.type === "hide") {
      state.panelPreferences[destinationKey(meta(ctx))] = false;
      await ui.clear(ctx);
      await dashboard.tick();
      return;
    }
    if (a.type === "dashboard-toggle") {
      const key = destinationKey(meta(ctx));
      state.panelPreferences[key] = state.panelPreferences[key] === false;
      await ui.clear(ctx);
      await dashboard.tick();
      return dashboardMenu(ctx);
    }
    if (a.type === "stop") {
      for (const [key, active] of dashboard.activeFor(meta(ctx))) {
        active.stopRequested = true;
        active.abortController?.abort();
        if (active.workerJobId)
          await execution.cancel(active, active.workerJobId);
        const item = Object.values(state.tasks).find(
          (x) => taskChatKey(x.id) === key && x.owner === scopeKey(ctx),
        );
        if (item) await scheduler.stopRun(item);
      }
      return dashboardMenu(ctx);
    }
    throw new Error(t("expired"));
  }
  return { action };
}
