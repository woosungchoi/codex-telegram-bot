import { TIME_PRESET_CHOICES } from "./preferences.js";
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

  function runtimeKeyboard() {
    return withMenuCloseButton(inlineKeyboard([
      [
        { text: t("output"), callback_data: "p:settings_runtime_output" },
        { text: t("queue"), callback_data: "p:settings_runtime_queue" }
      ],
      [
        { text: t("cleanup"), callback_data: "p:settings_runtime_cleanup" },
        { text: t("snapshots"), callback_data: "p:settings_runtime_snapshot" }
      ],
      [{ text: "Codex", callback_data: "p:settings_runtime_codex" }],
      [{ text: t("settings"), callback_data: "p:settings" }, { text: t("main"), callback_data: "p:main" }],
      [{ text: `← ${t("back")}`, callback_data: "p:settings" }]
    ]));
  }

  function runtimeOutputKeyboard() {
    return inlineKeyboard([
      [
        { text: "Reactions on", callback_data: "set:runtime_reactions:on" },
        { text: "off", callback_data: "set:runtime_reactions:off" },
        { text: t("default"), callback_data: "set:runtime_reactions:default" }
      ],
      [
        { text: "Markdown", callback_data: "set:runtime_answerformat:markdown" },
        { text: "Safe", callback_data: "set:runtime_answerformat:safe" },
        { text: "Plain", callback_data: "set:runtime_answerformat:off" },
        { text: t("default"), callback_data: "set:runtime_answerformat:default" }
      ],
      [
        { text: "Notice off", callback_data: "set:runtime_completionnotice:0" },
        { text: "90s", callback_data: "set:runtime_completionnotice:90" },
        { text: "180s", callback_data: "set:runtime_completionnotice:180" },
        { text: t("default"), callback_data: "set:runtime_completionnotice:default" }
      ],
      [
        { text: "Chars 2000", callback_data: "set:runtime_maxchars:2000" },
        { text: "3500", callback_data: "set:runtime_maxchars:3500" },
        { text: "4000", callback_data: "set:runtime_maxchars:4000" },
        { text: t("default"), callback_data: "set:runtime_maxchars:default" }
      ],
      [
        { text: "Logs 40", callback_data: "set:runtime_logsmax:40" },
        { text: "80", callback_data: "set:runtime_logsmax:80" },
        { text: "160", callback_data: "set:runtime_logsmax:160" },
        { text: t("default"), callback_data: "set:runtime_logsmax:default" }
      ],
      [
        { text: "Edit 4s", callback_data: "set:runtime_progressedit:4" },
        { text: "8s", callback_data: "set:runtime_progressedit:8" },
        { text: "15s", callback_data: "set:runtime_progressedit:15" },
        { text: t("default"), callback_data: "set:runtime_progressedit:default" }
      ],
      [{ text: t("runtime"), callback_data: "p:settings_runtime" }, { text: t("settings"), callback_data: "p:settings" }]
    ]);
  }

  function runtimeQueueKeyboard() {
    return inlineKeyboard([
      [
        { text: "Max 5", callback_data: "set:runtime_pendingmax:5" },
        { text: "10", callback_data: "set:runtime_pendingmax:10" },
        { text: "25", callback_data: "set:runtime_pendingmax:25" },
        { text: t("default"), callback_data: "set:runtime_pendingmax:default" }
      ],
      [
        { text: "Expiry off", callback_data: "set:runtime_pendingage:0" },
        { text: "1h", callback_data: "set:runtime_pendingage:3600" },
        { text: "2h", callback_data: "set:runtime_pendingage:7200" },
        { text: "24h", callback_data: "set:runtime_pendingage:86400" },
        { text: t("default"), callback_data: "set:runtime_pendingage:default" }
      ],
      [{ text: t("runtime"), callback_data: "p:settings_runtime" }, { text: t("settings"), callback_data: "p:settings" }]
    ]);
  }

  function runtimeCodexKeyboard() {
    return withMenuCloseButton(inlineKeyboard([
      [
        { text: "Sidecar", callback_data: "set:runtime_workermode:sidecar" },
        { text: "Inline", callback_data: "set:runtime_workermode:inline" },
        { text: t("default"), callback_data: "set:runtime_workermode:default" }
      ],
      [
        { text: "SDK", callback_data: "set:runtime_codextransport:sdk" },
        { text: "app-server direct", callback_data: "set:runtime_codextransport:app-server-direct" },
        { text: t("default"), callback_data: "set:runtime_codextransport:default" }
      ],
      [
        { text: "Worker poll 1s", callback_data: "set:runtime_workerpoll:1000" },
        { text: "3s", callback_data: "set:runtime_workerpoll:3000" },
        { text: t("default"), callback_data: "set:runtime_workerpoll:default" }
      ],
      [
        { text: "Timeout 3s", callback_data: "set:runtime_appservertimeout:3000" },
        { text: "5s", callback_data: "set:runtime_appservertimeout:5000" },
        { text: "10s", callback_data: "set:runtime_appservertimeout:10000" },
        { text: t("default"), callback_data: "set:runtime_appservertimeout:default" }
      ],
      [
        { text: "Test worker", callback_data: "tool:worker_status" },
        { text: "Test app-server direct", callback_data: "tool:appserver_status" }
      ],
      [{ text: "Save & restart", callback_data: "act:restart" }],
      [{ text: t("runtime"), callback_data: "p:settings_runtime" }, { text: t("settings"), callback_data: "p:settings" }]
    ]));
  }

  function runtimeCleanupKeyboard() {
    return inlineKeyboard([
      [
        { text: t("on"), callback_data: "set:runtime_cleanup:on" },
        { text: t("off"), callback_data: "set:runtime_cleanup:off" },
        { text: t("default"), callback_data: "set:runtime_cleanup:default" }
      ],
      timePresetButtons("runtime_cleanuptime"),
      [
        { text: "Keep 7d", callback_data: "set:runtime_cleanupretention:7" },
        { text: "14d", callback_data: "set:runtime_cleanupretention:14" },
        { text: "30d", callback_data: "set:runtime_cleanupretention:30" },
        { text: t("default"), callback_data: "set:runtime_cleanupretention:default" }
      ],
      [
        { text: "Q 7d", callback_data: "set:runtime_cleanupquarantine:7" },
        { text: "14d", callback_data: "set:runtime_cleanupquarantine:14" },
        { text: "30d", callback_data: "set:runtime_cleanupquarantine:30" },
        { text: t("default"), callback_data: "set:runtime_cleanupquarantine:default" }
      ],
      [
        { text: "TTL 12h", callback_data: "set:runtime_cleanupttl:12" },
        { text: "24h", callback_data: "set:runtime_cleanupttl:24" },
        { text: "48h", callback_data: "set:runtime_cleanupttl:48" },
        { text: t("default"), callback_data: "set:runtime_cleanupttl:default" }
      ],
      [{ text: t("runtime"), callback_data: "p:settings_runtime" }, { text: t("settings"), callback_data: "p:settings" }]
    ]);
  }

  function runtimeSnapshotKeyboard() {
    return inlineKeyboard([
      [
        { text: t("on"), callback_data: "set:runtime_snapshot:on" },
        { text: t("off"), callback_data: "set:runtime_snapshot:off" },
        { text: t("default"), callback_data: "set:runtime_snapshot:default" }
      ],
      timePresetButtons("runtime_snapshottime"),
      [
        { text: "Keep 7d", callback_data: "set:runtime_snapshotretention:7" },
        { text: "14d", callback_data: "set:runtime_snapshotretention:14" },
        { text: "30d", callback_data: "set:runtime_snapshotretention:30" },
        { text: t("default"), callback_data: "set:runtime_snapshotretention:default" }
      ],
      [{ text: t("runtime"), callback_data: "p:settings_runtime" }, { text: t("settings"), callback_data: "p:settings" }]
    ]);
  }

  function timePresetButtons(key) {
    return [
      ...TIME_PRESET_CHOICES.map(([id, label]) => ({ text: label, callback_data: `set:${key}:${id}` })),
      { text: t("default"), callback_data: `set:${key}:default` }
    ];
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
    runtimeCleanupKeyboard,
    runtimeCodexKeyboard,
    runtimeKeyboard,
    runtimeOutputKeyboard,
    runtimeQueueKeyboard,
    runtimeSnapshotKeyboard,
    statusKeyboard,
    toolsKeyboard,
    uploadCleanupKeyboard,
    withToolsBack
  };
}
