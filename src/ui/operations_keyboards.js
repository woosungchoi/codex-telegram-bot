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
  const t = text;

  function mainPanelKeyboard(chatKey) {
    const active = hasActiveTurn(chatKey);
    return inlineKeyboard([
      [
        { text: t("status"), callback_data: "p:status" },
        { text: t("queue"), callback_data: "p:queue" }
      ],
      [
        { text: t("settings"), callback_data: "p:settings" },
        { text: t("tools"), callback_data: "p:tools" }
      ],
      [
        { text: t("newThread"), callback_data: "act:new" },
        { text: t("resumeLast"), callback_data: "act:resume_last" }
      ],
      [
        { text: active ? t("stop") : t("help"), callback_data: active ? "act:stop" : "p:help" }
      ],
      [{ text: t("close"), callback_data: "ui:close:menu" }]
    ]);
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
    rows.push([{ text: `← ${t("back")}`, callback_data: "p:main" }]);
    const keyboard = inlineKeyboard(rows);
    return options?.closable === false ? keyboard : withMenuCloseButton(keyboard);
  }

  function toolsKeyboard() {
    return inlineKeyboard([
      [
        { text: "Health", callback_data: "tool:health" },
        { text: "Doctor", callback_data: "tool:doctor" }
      ],
      [
        { text: "Logs", callback_data: "tool:logs" },
        { text: "Error logs", callback_data: "tool:logs_error" }
      ],
      [
        { text: "Whoami", callback_data: "tool:whoami" },
        { text: "Config", callback_data: "tool:config" },
        { text: t("skills"), callback_data: "tool:skills" }
      ],
      [
        { text: "Backup", callback_data: "tool:backup" },
        { text: "Export", callback_data: "tool:export" }
      ],
      [
        { text: "Cleanup", callback_data: "tool:cleanup" },
        { text: "Forget", callback_data: "tool:forget" }
      ],
      [{ text: t("codexMaintenance"), callback_data: "tool:codex_maintenance", style: "primary" }],
      [{ text: t("main"), callback_data: "p:main" }],
      [{ text: `← ${t("back")}`, callback_data: "p:main" }]
    ]);
  }

  function withToolsBack() {
    return withMenuCloseButton(inlineKeyboard([
      [
        { text: t("tools"), callback_data: "p:tools" },
        { text: t("main"), callback_data: "p:main" }
      ],
      [{ text: `← ${t("back")}`, callback_data: "p:tools" }]
    ]));
  }

  function codexMaintenanceKeyboard() {
    const autoHandoff = maintenanceAutoHandoffEnabled();
    const autoRepair = maintenanceAutoSqliteRepairEnabled();
    return withMenuCloseButton(inlineKeyboard([
      [
        { text: "📊 Report", callback_data: "tool:codex_maintenance_report", style: "primary" },
        { text: "💾 Backup", callback_data: "tool:codex_maintenance_backup", style: "success" }
      ],
      [
        { text: "🧹 Config prune", callback_data: "tool:codex_maintenance_config", style: "primary" },
        { text: "📦 Worktrees archive", callback_data: "tool:codex_maintenance_worktrees", style: "primary" }
      ],
      [{ text: "🗄️ Logs rotate", callback_data: "tool:codex_maintenance_logs", style: "primary" }],
      [
        { text: "🧬 SQLite repair", callback_data: "tool:codex_maintenance_sqlite_repair", style: "danger" },
        { text: t("handoffCreate"), callback_data: "tool:codex_maintenance_handoff", style: "success" }
      ],
      [
        {
          text: `🤖 Auto handoff ${autoHandoff ? "on" : "off"}`,
          callback_data: "tool:codex_maintenance_auto_handoff",
          style: autoHandoff ? "success" : "primary"
        },
        {
          text: `🤖 Auto repair ${autoRepair ? "on" : "off"}`,
          callback_data: "tool:codex_maintenance_auto_sqlite_repair",
          style: autoRepair ? "danger" : "primary"
        }
      ],
      [
        { text: t("tools"), callback_data: "p:tools" },
        { text: t("main"), callback_data: "p:main" }
      ],
      [{ text: `← ${t("back")}`, callback_data: "p:tools" }]
    ]));
  }

  function codexMaintenanceBusyKeyboard() {
    return inlineKeyboard([[
      {
        text: t("processing"),
        callback_data: "tool:codex_maintenance",
        style: "primary"
      }
    ]]);
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
        { text: "safe", callback_data: "q:mode:safe" },
        { text: "interrupt", callback_data: "q:mode:interrupt" },
        { text: "side", callback_data: "q:mode:side" }
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
        { text: `${label} next`, callback_data: `queue:next:${turn.id}` }
      ]);
    }
    rows.push([{ text: t("main"), callback_data: "p:main" }]);
    rows.push([{ text: `← ${t("back")}`, callback_data: "p:main" }]);
    return withMenuCloseButton(inlineKeyboard(rows));
  }

  function uploadCleanupKeyboard(planId) {
    return inlineKeyboard([[
      {
        text: "Confirm upload cleanup",
        callback_data: `upload_cleanup_confirm:${planId}`
      }
    ]]);
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
