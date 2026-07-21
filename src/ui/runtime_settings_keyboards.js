import { TIME_PRESET_CHOICES } from "./preferences.js";
import { inlineKeyboard } from "./keyboard_helpers.js";

export function createRuntimeSettingsKeyboardViews({ text, withMenuCloseButton }) {
  const t = text;

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

  return {
    runtimeCleanupKeyboard,
    runtimeCodexKeyboard,
    runtimeKeyboard,
    runtimeOutputKeyboard,
    runtimeQueueKeyboard,
    runtimeSnapshotKeyboard
  };
}
