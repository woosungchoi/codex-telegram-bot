import { b } from "../telegram/html.js";

export function createToolCallbackController({
  settings,
  state,
  telegram,
  keyboards,
  diagnostics,
  skills,
  backup,
  cleanup,
  maintenance,
  persistence,
  formatting,
  localization
}) {
  async function handleToolButton(ctx, action) {
    const chatKey = telegram.getChatKey(ctx);
    if (action === "health") {
      await telegram.editOrReplyHtml(ctx, await diagnostics.formatHealth(), keyboards.withToolsBack());
    } else if (action === "doctor") {
      await telegram.editOrReplyHtml(
        ctx,
        await diagnostics.formatDoctor(chatKey),
        keyboards.withToolsBack()
      );
    } else if (action === "logs") {
      await telegram.editOrReplyHtml(ctx, await diagnostics.formatLogs(ctx), keyboards.withToolsBack());
    } else if (action === "logs_error") {
      await telegram.editOrReplyHtml(
        ctx,
        await diagnostics.formatLogs(ctx, "error"),
        keyboards.withToolsBack()
      );
    } else if (action === "whoami") {
      await telegram.editOrReplyHtml(ctx, diagnostics.formatWhoami(ctx), keyboards.withToolsBack());
    } else if (action === "config") {
      await telegram.editOrReplyHtml(ctx, diagnostics.formatConfig(), keyboards.withToolsBack());
    } else if (action === "skills") {
      await skills.replyStatus(
        ctx,
        {
          config: settings.config,
          runtimeValue: settings.runtimeValue,
          replyHtml: telegram.replyHtml,
          editOrReplyHtml: telegram.editOrReplyHtml
        },
        { edit: true, extra: keyboards.withToolsBack() }
      );
    } else if (action === "appserver_status") {
      await diagnostics.handleAppServerStatus(ctx);
    } else if (action === "worker_status") {
      await diagnostics.handleWorkerStatus(ctx);
    } else if (action === "backup") {
      const result = await backup.createState("manual");
      await telegram.replyHtml(ctx, formatting.keyValue("Backup created:", [
        ["file", result.path],
        ["size", formatting.bytes(result.bytes)],
        ["chats", result.chatCount]
      ]));
      await telegram.replyDocument(ctx, result.path, "Codex Telegram Bot backup");
    } else if (action === "export") {
      const file = await backup.createChatExport(chatKey);
      await telegram.replyHtml(ctx, formatting.keyValue("Chat export created:", [
        ["file", file.path],
        ["size", formatting.bytes(file.bytes)]
      ]));
      await telegram.replyDocument(ctx, file.path, "Current chat export");
    } else if (action === "cleanup") {
      await cleanup.handleCommand(ctx);
    } else if (action === "codex_maintenance") {
      await telegram.editOrReplyHtml(
        ctx,
        maintenance.menuHtml(),
        keyboards.maintenance()
      );
    } else if (action === "codex_maintenance_report") {
      await telegram.editOrReplyHtml(
        ctx,
        maintenance.formatReport(await maintenance.readReport()),
        keyboards.maintenance()
      );
    } else if (action === "codex_maintenance_backup") {
      await runMaintenanceAction(ctx, "backup", "busyBackup", "busyBackupDetail");
    } else if (action === "codex_maintenance_config") {
      if (await telegram.rejectCallbackIfActive(ctx, chatKey)) return;
      await runMaintenanceAction(ctx, "config-prune", "busyConfig", "busyConfigDetail");
    } else if (action === "codex_maintenance_worktrees") {
      if (await telegram.rejectCallbackIfActive(ctx, chatKey)) return;
      await runMaintenanceAction(
        ctx,
        "worktree-archive",
        "busyWorktrees",
        "busyWorktreesDetail"
      );
    } else if (action === "codex_maintenance_logs") {
      if (await telegram.rejectCallbackIfActive(ctx, chatKey)) return;
      await runMaintenanceAction(ctx, "log-rotate", "busyLogs", "busyLogsDetail");
    } else if (action === "codex_maintenance_sqlite_repair") {
      await telegram.editOrReplyHtml(
        ctx,
        maintenance.sqliteRepairConfirmHtml(),
        keyboards.withClose(keyboards.inline([
          [
            {
              text: localization.text("repairRun"),
              callback_data: "tool:codex_maintenance_sqlite_repair_apply",
              style: "danger"
            },
            {
              text: localization.text("cancel"),
              callback_data: "tool:codex_maintenance",
              style: "primary"
            }
          ],
          [{ text: `← ${localization.text("back")}`, callback_data: "tool:codex_maintenance" }]
        ]))
      );
    } else if (action === "codex_maintenance_sqlite_repair_apply") {
      if (await telegram.rejectCallbackIfActive(ctx, chatKey)) return;
      await runMaintenanceAction(
        ctx,
        "sqlite-metadata-repair",
        "busyRepair",
        "busyRepairDetail"
      );
    } else if (action === "codex_maintenance_handoff") {
      if (await telegram.rejectCallbackIfActive(ctx, chatKey)) return;
      await telegram.editOrReplyHtml(
        ctx,
        `${b(localization.text("busyHandoff"))}\n${localization.text("busyHandoffDetail")}`,
        keyboards.maintenanceBusy()
      );
      await telegram.editOrReplyHtml(
        ctx,
        maintenance.formatHandoff(await maintenance.createCurrentHandoff(chatKey)),
        keyboards.maintenance()
      );
    } else if (action === "codex_maintenance_auto_handoff") {
      state.maintenance.autoHandoffEnabled = !maintenance.autoHandoffEnabled();
      await persistence.save();
      await showMaintenanceMenu(ctx);
    } else if (action === "codex_maintenance_auto_sqlite_repair") {
      state.maintenance.autoSqliteRepairEnabled = !maintenance.autoSqliteRepairEnabled();
      await persistence.save();
      await showMaintenanceMenu(ctx);
    } else if (action === "forget") {
      await telegram.editOrReplyHtml(
        ctx,
        `${b(localization.text("forgetConfirmTitle"))}\n${localization.text("forgetConfirmBody")}`,
        keyboards.withClose(keyboards.inline([
          [
            { text: localization.text("forgetRun"), callback_data: "confirm:forget" },
            { text: localization.text("cancel"), callback_data: "p:tools" }
          ],
          [{ text: `← ${localization.text("back")}`, callback_data: "p:tools" }]
        ]))
      );
    }
  }

  async function runMaintenanceAction(ctx, action, titleKey, detailKey) {
    await telegram.editOrReplyHtml(
      ctx,
      `${b(localization.text(titleKey))}\n${localization.text(detailKey)}`,
      keyboards.maintenanceBusy()
    );
    await telegram.editOrReplyHtml(
      ctx,
      maintenance.formatResult(await maintenance.run(action)),
      keyboards.maintenance()
    );
  }

  async function showMaintenanceMenu(ctx) {
    await telegram.editOrReplyHtml(ctx, maintenance.menuHtml(), keyboards.maintenance());
  }

  return { handleToolButton };
}
