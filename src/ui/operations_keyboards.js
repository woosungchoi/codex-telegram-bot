import { createMessageFormatter } from "../i18n.js";
import { renderMenu } from "./menu_definition.js";
import { inlineKeyboard } from "./keyboard_helpers.js";

export function createOperationsKeyboardViews({
  text,
  hasActiveTurn,
  sideTurnCount,
  isQueuePaused,
  pendingTurnsFor,
  maintenanceAutoHandoffEnabled,
  maintenanceAutoSqliteRepairEnabled,
  withMenuCloseButton
}) {
  const msg = createMessageFormatter(text);
  const t = text;

  function mainPanelKeyboard(chatKey) {
    const active = hasActiveTurn(chatKey);
    return withMenuCloseButton(inlineKeyboard([
      [
        { text: `📋 ${t("status")}`, callback_data: "p:status" },
        { text: `📥 ${t("queue")}`, callback_data: "p:queue" }
      ],
      [
        { text: `⚙️ ${t("settings")}`, callback_data: "p:settings" },
        { text: `🛠️ ${t("tools")}`, callback_data: "p:tools" }
      ],
      [
        { text: t("accounts"), callback_data: "acct:list" },
        { text: t("accountAdd"), callback_data: "acct:login" }
      ],
      [{ text: t("accountUsage"), callback_data: "acct:usage" }],
      [
        { text: t("workspaceProjects"), callback_data: "w:projects" },
        { text: t("workspaceSessions"), callback_data: "w:sessions" }
      ],
      [
        { text: t("workspaceTasks"), callback_data: "w:tasks" },
        { text: t("workspaceDashboard"), callback_data: "w:dashboard" }
      ],
      [
        { text: t("workspaceMcp"), callback_data: "w:mcp" },
        { text: t("workspaceTopics"), callback_data: "w:forum" }
      ],
      [
        { text: `🆕 ${t("newThread")}`, callback_data: "act:new" },
        { text: `▶️ ${t("resumeLast")}`, callback_data: "act:resume_last" }
      ],
      [
        { text: active ? `🛑 ${t("stop")}` : `❓ ${t("help")}`, callback_data: active ? "act:stop" : "p:help" }
      ],
      [{ text: `✖ ${t("close")}`, callback_data: "ui:close:menu" }]
    ]));
  }

  function statusKeyboard(chatKey, options) {
    const rows = [
      [
        { text: t("refresh"), callback_data: "p:status" },
        { text: t("queue"), callback_data: "p:queue" }
      ],
      [{ text: t("usageRefresh"), callback_data: "usage:refresh" }],
      [
        { text: t("settings"), callback_data: "p:settings" },
        { text: t("main"), callback_data: "p:main" }
      ]
    ];
    if (hasActiveTurn(chatKey) || sideTurnCount(chatKey) > 0) {
      rows.splice(1, 0, [{ text: t("stop"), callback_data: "act:stop" }]);
    }
    rows.push([{ role: "back", text: `← ${t("back")}`, callback_data: "p:main" }]);
    const keyboard = inlineKeyboard(rows);
    return options?.closable === false ? renderMenu(keyboard, { text: t, close: false }) : withMenuCloseButton(keyboard);
  }

  function toolsKeyboard() {
    return withMenuCloseButton(inlineKeyboard([
      [{ text: t("workspaceMcp"), callback_data: "w:mcp:tools" }],
      [
        { text: msg("ui.health"), callback_data: "tool:health" },
        { text: msg("ui.doctor"), callback_data: "tool:doctor" }
      ],
      [
        { text: msg("ui.logs"), callback_data: "tool:logs" },
        { text: msg("ui.errorLogs"), callback_data: "tool:logs_error" }
      ],
      [
        { text: msg("ui.whoami"), callback_data: "tool:whoami" },
        { text: msg("ui.config2"), callback_data: "tool:config" },
        { text: t("skills"), callback_data: "tool:skills" }
      ],
      [
        { text: msg("ui.backup"), callback_data: "tool:backup" },
        { text: msg("ui.export"), callback_data: "tool:export" }
      ],
      [
        { text: msg("cleanup"), callback_data: "tool:cleanup" },
        { text: msg("ui.forget"), callback_data: "tool:forget" }
      ],
      [{ text: t("codexMaintenance"), callback_data: "tool:codex_maintenance", style: "primary" }],
      [{ text: t("main"), callback_data: "p:main" }],
      [{ role: "back", text: `← ${t("back")}`, callback_data: "p:main" }]
    ]));
  }

  function withToolsBack() {
    return withMenuCloseButton(inlineKeyboard([
      [
        { text: t("tools"), callback_data: "p:tools" },
        { text: t("main"), callback_data: "p:main" }
      ],
      [{ role: "back", text: `← ${t("back")}`, callback_data: "p:tools" }]
    ]));
  }

  function codexMaintenanceKeyboard() {
    const autoHandoff = maintenanceAutoHandoffEnabled();
    const autoRepair = maintenanceAutoSqliteRepairEnabled();
    return withMenuCloseButton(inlineKeyboard([
      [
        { text: msg("ui.report"), callback_data: "tool:codex_maintenance_report", style: "primary" },
        { text: msg("ui.backup2"), callback_data: "tool:codex_maintenance_backup", style: "success" }
      ],
      [
        { text: msg("ui.configPrune"), callback_data: "tool:codex_maintenance_config", style: "primary" },
        { text: msg("ui.worktreesArchive"), callback_data: "tool:codex_maintenance_worktrees", style: "primary" }
      ],
      [{ text: msg("ui.logsRotate"), callback_data: "tool:codex_maintenance_logs", style: "primary" }],
      [
        { text: msg("ui.sqliteRepair"), callback_data: "tool:codex_maintenance_sqlite_repair", style: "danger" },
        { text: t("handoffCreate"), callback_data: "tool:codex_maintenance_handoff", style: "success" }
      ],
      [
        {
          text: msg("ui.autoHandoffLine", { value1: autoHandoff ? "on" : "off" }),
          callback_data: "tool:codex_maintenance_auto_handoff",
          style: autoHandoff ? "success" : "primary"
        },
        {
          text: msg("ui.autoRepairLine", { value1: autoRepair ? "on" : "off" }),
          callback_data: "tool:codex_maintenance_auto_sqlite_repair",
          style: autoRepair ? "danger" : "primary"
        }
      ],
      [
        { text: t("tools"), callback_data: "p:tools" },
        { text: t("main"), callback_data: "p:main" }
      ],
      [{ role: "back", text: `← ${t("back")}`, callback_data: "p:tools" }]
    ]));
  }

  function codexMaintenanceBusyKeyboard() {
    return withMenuCloseButton(inlineKeyboard([[
      {
        text: t("processing"),
        callback_data: "tool:codex_maintenance",
        style: "primary"
      }
    ], [{ role: "back", text: `← ${t("back")}`, callback_data: "tool:codex_maintenance" }]]));
  }

  function queueKeyboard(chatKey) {
    const paused = isQueuePaused(chatKey);
    const pendingTurns = pendingTurnsFor(chatKey);
    const rows = [
      [
        {
          text: paused ? t("resumeAuto") : t("pauseAuto"),
          callback_data: paused ? "q:resume" : "q:pause"
        },
        { text: t("refresh"), callback_data: "p:queue" }
      ],
      [
        { text: msg("ui.safe"), callback_data: "q:mode:safe" },
        { text: msg("ui.interrupt"), callback_data: "q:mode:interrupt" },
        { text: msg("ui.side"), callback_data: "q:mode:side" }
      ]
    ];
    if (pendingTurns.length > 0) {
      rows.push([{ text: t("clearAll"), callback_data: "q:clear" }]);
    }
    for (const [index, turn] of pendingTurns.slice(0, 10).entries()) {
      const label = `#${index + 1}`;
      rows.push([
        { text: `${label} ${t("cancelItem")}`, callback_data: `queue:cancel:${turn.id}` },
        { text: `${label} ↑`, callback_data: `queue:up:${turn.id}` },
        { text: msg("ui.nextLine", { value1: label }), callback_data: `queue:next:${turn.id}` }
      ]);
    }
    rows.push([{ text: t("main"), callback_data: "p:main" }]);
    rows.push([{ role: "back", text: `← ${t("back")}`, callback_data: "p:main" }]);
    return withMenuCloseButton(inlineKeyboard(rows));
  }

  function uploadCleanupKeyboard(planId) {
    return withMenuCloseButton(inlineKeyboard([[
      {
        text: msg("ui.confirmUploadCleanup"),
        callback_data: `upload_cleanup_confirm:${planId}`
      }
    ], [{ role: "back", text: `← ${t("back")}`, callback_data: "p:tools" }]]));
  }

  return {
    codexMaintenanceBusyKeyboard,
    codexMaintenanceKeyboard,
    mainPanelKeyboard,
    queueKeyboard,
    statusKeyboard,
    toolsKeyboard,
    uploadCleanupKeyboard,
    withToolsBack
  };
}
