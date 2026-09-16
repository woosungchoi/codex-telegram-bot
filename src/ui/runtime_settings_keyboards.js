import { createMessageFormatter } from "../i18n.js";
import { TIME_PRESET_CHOICES } from "./preferences.js";
import { inlineKeyboard } from "./keyboard_helpers.js";

export function createRuntimeSettingsKeyboardViews({ text, withMenuCloseButton }) {
  const msg = createMessageFormatter(text);
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
      [{ text: msg("ui.codex"), callback_data: "p:settings_runtime_codex" }],
      [{ text: t("settings"), callback_data: "p:settings" }, { text: t("main"), callback_data: "p:main" }],
      [{ role: "back", text: `← ${t("back")}`, callback_data: "p:settings" }]
    ]));
  }

  function runtimeOutputKeyboard() {
    return inlineKeyboard([
      [
        { text: msg("ui.reactionsOn"), callback_data: "set:runtime_reactions:on" },
        { text: msg("ui.off"), callback_data: "set:runtime_reactions:off" },
        { text: t("default"), callback_data: "set:runtime_reactions:default" }
      ],
      [
        { text: msg("ui.markdown"), callback_data: "set:runtime_answerformat:markdown" },
        { text: msg("ui.safe2"), callback_data: "set:runtime_answerformat:safe" },
        { text: msg("ui.plain"), callback_data: "set:runtime_answerformat:off" },
        { text: t("default"), callback_data: "set:runtime_answerformat:default" }
      ],
      [
        { text: msg("ui.noticeOff"), callback_data: "set:runtime_completionnotice:0" },
        { text: msg("units.seconds", { count: 90 }), callback_data: "set:runtime_completionnotice:90" },
        { text: msg("units.seconds", { count: 180 }), callback_data: "set:runtime_completionnotice:180" },
        { text: t("default"), callback_data: "set:runtime_completionnotice:default" }
      ],
      [
        { text: msg("ui.chars2000"), callback_data: "set:runtime_maxchars:2000" },
        { text: "3500", callback_data: "set:runtime_maxchars:3500" },
        { text: "4000", callback_data: "set:runtime_maxchars:4000" },
        { text: t("default"), callback_data: "set:runtime_maxchars:default" }
      ],
      [
        { text: msg("ui.logs40"), callback_data: "set:runtime_logsmax:40" },
        { text: "80", callback_data: "set:runtime_logsmax:80" },
        { text: "160", callback_data: "set:runtime_logsmax:160" },
        { text: t("default"), callback_data: "set:runtime_logsmax:default" }
      ],
      [
        { text: msg("ui.edit4s"), callback_data: "set:runtime_progressedit:4" },
        { text: msg("units.seconds", { count: 8 }), callback_data: "set:runtime_progressedit:8" },
        { text: msg("units.seconds", { count: 15 }), callback_data: "set:runtime_progressedit:15" },
        { text: t("default"), callback_data: "set:runtime_progressedit:default" }
      ],
      [{ text: t("runtime"), callback_data: "p:settings_runtime" }, { text: t("settings"), callback_data: "p:settings" }]
    ]);
  }

  function runtimeQueueKeyboard() {
    return inlineKeyboard([
      [
        { text: msg("ui.max5"), callback_data: "set:runtime_pendingmax:5" },
        { text: "10", callback_data: "set:runtime_pendingmax:10" },
        { text: "25", callback_data: "set:runtime_pendingmax:25" },
        { text: t("default"), callback_data: "set:runtime_pendingmax:default" }
      ],
      [
        { text: msg("ui.expiryOff"), callback_data: "set:runtime_pendingage:0" },
        { text: msg("units.hours", { count: 1 }), callback_data: "set:runtime_pendingage:3600" },
        { text: msg("units.hours", { count: 2 }), callback_data: "set:runtime_pendingage:7200" },
        { text: msg("units.hours", { count: 24 }), callback_data: "set:runtime_pendingage:86400" },
        { text: t("default"), callback_data: "set:runtime_pendingage:default" }
      ],
      [{ text: t("runtime"), callback_data: "p:settings_runtime" }, { text: t("settings"), callback_data: "p:settings" }]
    ]);
  }

  function runtimeCodexKeyboard() {
    return withMenuCloseButton(inlineKeyboard([
      [
        { text: msg("ui.sidecar"), callback_data: "set:runtime_workermode:sidecar" },
        { text: msg("ui.inline"), callback_data: "set:runtime_workermode:inline" },
        { text: t("default"), callback_data: "set:runtime_workermode:default" }
      ],
      [
        { text: msg("ui.sdk"), callback_data: "set:runtime_codextransport:sdk" },
        { text: msg("ui.appServerDirect"), callback_data: "set:runtime_codextransport:app-server-direct" },
        { text: t("default"), callback_data: "set:runtime_codextransport:default" }
      ],
      [
        { text: msg("ui.workerPoll1s"), callback_data: "set:runtime_workerpoll:1000" },
        { text: msg("units.seconds", { count: 3 }), callback_data: "set:runtime_workerpoll:3000" },
        { text: t("default"), callback_data: "set:runtime_workerpoll:default" }
      ],
      [
        { text: msg("ui.timeout3s"), callback_data: "set:runtime_appservertimeout:3000" },
        { text: msg("units.seconds", { count: 5 }), callback_data: "set:runtime_appservertimeout:5000" },
        { text: msg("units.seconds", { count: 10 }), callback_data: "set:runtime_appservertimeout:10000" },
        { text: t("default"), callback_data: "set:runtime_appservertimeout:default" }
      ],
      [
        { text: msg("ui.testWorker"), callback_data: "tool:worker_status" },
        { text: msg("ui.testAppServerDirect"), callback_data: "tool:appserver_status" }
      ],
      [{ text: msg("ui.saveRestart"), callback_data: "act:restart" }],
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
      [
        { text: t("cleanupModeManual"), callback_data: "set:runtime_cleanupmode:manual" },
        { text: t("cleanupModeQuarantine"), callback_data: "set:runtime_cleanupmode:quarantine" }
      ],
      [
        {
          text: t("cleanupModeDelete"),
          callback_data: "set:runtime_cleanupmode:delete",
          style: "danger"
        },
        {
          text: t("cleanupModeBoth"),
          callback_data: "set:runtime_cleanupmode:both",
          style: "danger"
        }
      ],
      [{ text: t("cleanupModeDefault"), callback_data: "set:runtime_cleanupmode:default" }],
      timePresetButtons("runtime_cleanuptime"),
      [
        { text: msg("ui.keep7d"), callback_data: "set:runtime_cleanupretention:7" },
        { text: msg("units.days", { count: 14 }), callback_data: "set:runtime_cleanupretention:14" },
        { text: msg("units.days", { count: 30 }), callback_data: "set:runtime_cleanupretention:30" },
        { text: t("default"), callback_data: "set:runtime_cleanupretention:default" }
      ],
      [
        { text: msg("ui.quarantineDays", { count: 7 }), callback_data: "set:runtime_cleanupquarantine:7" },
        { text: msg("units.days", { count: 14 }), callback_data: "set:runtime_cleanupquarantine:14" },
        { text: msg("units.days", { count: 30 }), callback_data: "set:runtime_cleanupquarantine:30" },
        { text: t("default"), callback_data: "set:runtime_cleanupquarantine:default" }
      ],
      [
        { text: msg("ui.ttl12h"), callback_data: "set:runtime_cleanupttl:12" },
        { text: msg("units.hours", { count: 24 }), callback_data: "set:runtime_cleanupttl:24" },
        { text: msg("units.hours", { count: 48 }), callback_data: "set:runtime_cleanupttl:48" },
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
        { text: msg("ui.keep7d"), callback_data: "set:runtime_snapshotretention:7" },
        { text: msg("units.days", { count: 14 }), callback_data: "set:runtime_snapshotretention:14" },
        { text: msg("units.days", { count: 30 }), callback_data: "set:runtime_snapshotretention:30" },
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
