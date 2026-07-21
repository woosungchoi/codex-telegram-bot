import { LANGUAGE_CHOICES } from "../i18n.js";
import {
  LOCALE_CHOICES,
  TIME_PRESET_CHOICES,
  TIME_ZONE_GROUPS,
  formatTimeZoneChoiceLabel,
  timeZoneChoicesForGroup
} from "./preferences.js";

export function booleanOptionKeyboardRows(key, settingsLabel) {
  return [
    [
      { text: "default", callback_data: `set:${key}:default` },
      { text: "on", callback_data: `set:${key}:on` },
      { text: "off", callback_data: `set:${key}:off` }
    ],
    [{ text: settingsLabel, callback_data: "p:settings" }]
  ];
}

function chunk(items, size) {
  const rows = [];
  for (let index = 0; index < items.length; index += size) {
    rows.push(items.slice(index, index + size));
  }
  return rows;
}

export function modelSelectionKeyboard(models, { callbackPrefix = "model:set:" } = {}) {
  const buttons = models.map((model) => ({
    text: `${model.displayName}${model.fastSupported ? " ⚡" : ""}`,
    callback_data: `${callbackPrefix}${model.slug}`
  }));
  return {
    reply_markup: {
      inline_keyboard: [
        ...chunk(buttons, 2),
        [{ text: "Default", callback_data: `${callbackPrefix}default` }]
      ]
    }
  };
}

export function reasoningSelectionKeyboard(reasoningOptions, { callbackPrefix = "reasoning:set:" } = {}) {
  const buttons = [
    { text: "Default", callback_data: `${callbackPrefix}default` },
    ...reasoningOptions.map(({ effort }) => ({
      text: effort,
      callback_data: `${callbackPrefix}${effort}`
    }))
  ];
  return {
    reply_markup: {
      inline_keyboard: chunk(buttons, 3)
    }
  };
}

export function createRuntimeKeyboardViews({
  text,
  hasActiveTurn,
  sideTurnCount,
  currentLanguage,
  currentTimeZone,
  currentLocale
}) {
  const t = text;

  function mainPanelKeyboard(chatKey) {
    const active = hasActiveTurn(chatKey);
    const rows = [
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
    ];
    return inlineKeyboard(rows);
  }

  function statusKeyboard(chatKey, options) {
    const rows = [
      [
        { text: t("refresh"), callback_data: "p:status" },
        { text: t("queue"), callback_data: "p:queue" }
      ],
      [
        { text: t("usageRefresh"), callback_data: "usage:refresh" }
      ],
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

  function settingsKeyboard() {
    return withMenuCloseButton(inlineKeyboard([
      [
        { text: t("model"), callback_data: "p:settings_model" },
        { text: "Thinking", callback_data: "p:settings_reasoning" }
      ],
      [
        { text: "Fast", callback_data: "p:settings_fast" },
        { text: "Sandbox", callback_data: "p:settings_sandbox" }
      ],
      [
        { text: "Approval", callback_data: "p:settings_approval" },
        { text: "Web Search", callback_data: "p:settings_web" }
      ],
      [
        { text: "Network", callback_data: "p:settings_network" },
        { text: "Stream", callback_data: "p:settings_stream" }
      ],
      [
        { text: "Live Progress", callback_data: "p:settings_live_progress" }
      ],
      [
        { text: t("runtime"), callback_data: "p:settings_runtime" }
      ],
      [
        { text: "Git Check", callback_data: "p:settings_git" },
        { text: "Paths", callback_data: "p:settings_paths" }
      ],
      [
        { text: "Schema", callback_data: "p:settings_schema" },
        { text: t("prefsReset"), callback_data: "confirm:prefs_reset" }
      ],
      [
        { text: t("language"), callback_data: "p:settings_language" },
        { text: t("timeZone"), callback_data: "p:settings_timezone" }
      ],
      [
        { text: t("locale"), callback_data: "p:settings_locale" },
        { text: t("main"), callback_data: "p:main" }
      ],
      [{ text: `← ${t("back")}`, callback_data: "p:main" }]
    ]));
  }

  function fastKeyboard() {
    return inlineKeyboard([
      [
        { text: t("on"), callback_data: "set:fast:on" },
        { text: t("off"), callback_data: "set:fast:off" }
      ],
      [
        { text: t("settings"), callback_data: "p:settings" },
        { text: t("main"), callback_data: "p:main" }
      ]
    ]);
  }

  function standaloneModelSelectionKeyboard(models, session) {
    return withSelectionCancel(
      modelSelectionKeyboard(models, { callbackPrefix: `m:${session.token}:` }),
      session
    );
  }

  function standaloneReasoningSelectionKeyboard(reasoningOptions, session) {
    return withSelectionCancel(
      reasoningSelectionKeyboard(reasoningOptions, { callbackPrefix: `r:${session.token}:` }),
      session
    );
  }

  function standaloneFastSelectionKeyboard(session) {
    return withSelectionCancel(inlineKeyboard([[
      { text: t("on"), callback_data: `f:${session.token}:on` },
      { text: t("off"), callback_data: `f:${session.token}:off` }
    ]]), session);
  }

  function withSelectionCancel(keyboard, session) {
    const rows = keyboard?.reply_markup?.inline_keyboard
      ? keyboard.reply_markup.inline_keyboard.map((row) => [...row])
      : [];
    rows.push([{ text: t("cancel"), callback_data: `x:${session.token}` }]);
    return inlineKeyboard(rows);
  }

  function emptyInlineKeyboard() {
    return inlineKeyboard([]);
  }

  function settingsSelectionKeyboard(keyboard, previousPanel) {
    const rows = keyboard?.reply_markup?.inline_keyboard
      ? keyboard.reply_markup.inline_keyboard.map((row) => [...row])
      : [];
    const navigation = [];
    if (!rows.some((row) => row.some(({ callback_data: callbackData }) => callbackData === "p:settings"))) {
      navigation.push({ text: t("settings"), callback_data: "p:settings" });
    }
    if (!rows.some((row) => row.some(({ callback_data: callbackData }) => callbackData === "p:main"))) {
      navigation.push({ text: t("main"), callback_data: "p:main" });
    }
    if (navigation.length > 0) rows.push(navigation);
    return withMenuCloseButton(withPreviousPanelButton(inlineKeyboard(rows), previousPanel));
  }

  function sandboxKeyboard() {
    return inlineKeyboard([
      [
        { text: "default", callback_data: "set:sandbox:default" },
        { text: "read-only", callback_data: "set:sandbox:ro" }
      ],
      [
        { text: "workspace-write", callback_data: "set:sandbox:ww" },
        { text: "danger-full-access", callback_data: "set:sandbox:danger" }
      ],
      [{ text: t("settings"), callback_data: "p:settings" }]
    ]);
  }

  function approvalKeyboard() {
    return inlineKeyboard([
      [
        { text: "default", callback_data: "set:approval:default" },
        { text: "never", callback_data: "set:approval:never" }
      ],
      [
        { text: "on-request", callback_data: "set:approval:on_request" },
        { text: "on-failure", callback_data: "set:approval:on_failure" }
      ],
      [
        { text: "untrusted", callback_data: "set:approval:untrusted" },
        { text: t("settings"), callback_data: "p:settings" }
      ]
    ]);
  }

  function webSearchKeyboard() {
    return inlineKeyboard([
      [
        { text: "default", callback_data: "set:web:default" },
        { text: "disabled", callback_data: "set:web:disabled" }
      ],
      [
        { text: "cached", callback_data: "set:web:cached" },
        { text: "live", callback_data: "set:web:live" }
      ],
      [{ text: t("settings"), callback_data: "p:settings" }]
    ]);
  }

  function booleanOptionKeyboard(key) {
    return inlineKeyboard(booleanOptionKeyboardRows(key, t("settings")));
  }

  function liveProgressKeyboard() {
    return inlineKeyboard([
      [
        { text: t("on"), callback_data: "set:liveprogress:on" },
        { text: t("off"), callback_data: "set:liveprogress:off" },
        { text: t("default"), callback_data: "set:liveprogress:default" }
      ],
      [
        { text: t("liveProgressSourceAgent"), callback_data: "set:liveprogresssource:agent" },
        { text: t("liveProgressSourceActivity"), callback_data: "set:liveprogresssource:activity" },
        { text: t("liveProgressSourceBoth"), callback_data: "set:liveprogresssource:both" }
      ],
      [
        { text: t("liveProgressDeleteAlways"), callback_data: "set:liveprogressdelete:always" },
        { text: t("liveProgressDeleteOnSuccess"), callback_data: "set:liveprogressdelete:on_success" },
        { text: t("liveProgressDeleteNever"), callback_data: "set:liveprogressdelete:never" }
      ],
      [
        { text: t("liveProgressSourceDefault"), callback_data: "set:liveprogresssource:default" },
        { text: t("liveProgressDeleteDefault"), callback_data: "set:liveprogressdelete:default" }
      ],
      [
        { text: "brief", callback_data: "set:runtime_liveprogressmode:brief" },
        { text: "legacy ko", callback_data: "set:runtime_liveprogressmode:korean_brief" },
        { text: t("default"), callback_data: "set:runtime_liveprogressmode:default" }
      ],
      [
        { text: "10s", callback_data: "set:runtime_liveprogressinterval:10" },
        { text: "30s", callback_data: "set:runtime_liveprogressinterval:30" },
        { text: "60s", callback_data: "set:runtime_liveprogressinterval:60" },
        { text: t("default"), callback_data: "set:runtime_liveprogressinterval:default" }
      ],
      [{ text: t("settings"), callback_data: "p:settings" }, { text: t("main"), callback_data: "p:main" }]
    ]);
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
      [
        { text: "Codex", callback_data: "p:settings_runtime_codex" }
      ],
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
      [
        { text: "Save & restart", callback_data: "act:restart" }
      ],
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

  function pathsKeyboard() {
    return inlineKeyboard([
      [
        { text: "workdir default", callback_data: "set:workdir:default" },
        { text: t("clearDirs"), callback_data: "set:dirs:clear" }
      ],
      [{ text: t("settings"), callback_data: "p:settings" }]
    ]);
  }

  function schemaKeyboard() {
    return inlineKeyboard([
      [
        { text: t("schemaOff"), callback_data: "set:schema:off" },
        { text: t("settings"), callback_data: "p:settings" }
      ]
    ]);
  }

  function languageKeyboard() {
    const current = currentLanguage();
    return inlineKeyboard([
      ...chunkButtons(LANGUAGE_CHOICES.map(({ code: languageCode, emoji, nativeName }) => ({
        text: `${current === languageCode ? "✅ " : ""}${emoji} ${nativeName}`,
        callback_data: `set:language:${languageCode}`,
        style: current === languageCode ? "success" : "primary"
      })), 2),
      [{ text: t("settings"), callback_data: "p:settings" }, { text: t("main"), callback_data: "p:main" }]
    ]);
  }

  function chunkButtons(buttons, size) {
    const rows = [];
    for (let index = 0; index < buttons.length; index += size) rows.push(buttons.slice(index, index + size));
    return rows;
  }

  function timeZoneKeyboard() {
    return inlineKeyboard([
      ...chunkButtons(TIME_ZONE_GROUPS.map(([id, emoji, label]) => ({
        text: `${emoji} ${label}`,
        callback_data: `p:settings_timezone_${id}`
      })), 2),
      [{ text: t("default"), callback_data: "set:timezone:default" }],
      [{ text: t("settings"), callback_data: "p:settings" }, { text: t("main"), callback_data: "p:main" }]
    ]);
  }

  function timeZoneGroupKeyboard(groupId) {
    const choices = timeZoneChoicesForGroup(groupId);
    const columns = groupId === "utc" ? 2 : 1;
    return inlineKeyboard([
      ...chunkButtons(choices.map(([id, label, timeZone]) => ({
        text: currentTimeZone() === timeZone
          ? `✅ ${formatTimeZoneChoiceLabel(label, timeZone)}`
          : formatTimeZoneChoiceLabel(label, timeZone),
        callback_data: `set:timezone:${id}`
      })), columns),
      [{ text: t("settings"), callback_data: "p:settings" }, { text: t("main"), callback_data: "p:main" }],
      [{ text: `← ${t("back")}`, callback_data: "p:settings_timezone" }]
    ]);
  }

  function localeKeyboard() {
    return inlineKeyboard([
      ...chunkButtons(LOCALE_CHOICES.map(([id, label, locale]) => ({
        text: currentLocale() === locale ? `✅ ${label}` : label,
        callback_data: `set:locale:${id}`
      })), 2),
      [{ text: t("default"), callback_data: "set:locale:default" }],
      [{ text: t("settings"), callback_data: "p:settings" }, { text: t("main"), callback_data: "p:main" }]
    ]);
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
      [
        { text: t("codexMaintenance"), callback_data: "tool:codex_maintenance", style: "primary" }
      ],
      [{ text: t("main"), callback_data: "p:main" }],
      [{ text: `← ${t("back")}`, callback_data: "p:main" }]
    ]);
  }

  function backToMainKeyboard() {
    return withMenuCloseButton(inlineKeyboard([[{ text: t("main"), callback_data: "p:main" }]]));
  }

  function withPreviousPanelButton(keyboard, previousPanel) {
    if (!previousPanel) return keyboard;
    const callbackData = `p:${previousPanel}`;
    const rows = keyboard?.reply_markup?.inline_keyboard ? [...keyboard.reply_markup.inline_keyboard] : [];
    const hasPreviousButton = rows.some((row) => row.some((button) => (
      button?.callback_data === callbackData && String(button.text || "").includes("←")
    )));
    if (!hasPreviousButton) rows.push([{ text: `← ${t("back")}`, callback_data: callbackData }]);
    return inlineKeyboard(rows);
  }

  function withMenuCloseButton(keyboard) {
    const callbackData = "ui:close:menu";
    const rows = keyboard?.reply_markup?.inline_keyboard
      ? keyboard.reply_markup.inline_keyboard
        .map((row) => row.filter((button) => button?.callback_data !== callbackData))
        .filter((row) => row.length > 0)
      : [];
    rows.push([{ text: t("close"), callback_data: callbackData }]);
    return inlineKeyboard(rows);
  }

  function previousPanelFor(panel) {
    if (panel === "main") return null;
    if (["status", "queue", "settings", "tools", "help"].includes(panel)) return "main";
    if (panel.startsWith("settings_timezone_")) return "settings_timezone";
    if (panel.startsWith("settings_runtime_")) return "settings_runtime";
    if (panel.startsWith("settings_")) return "settings";
    return "main";
  }

  function inlineKeyboard(rows) {
    return { reply_markup: { inline_keyboard: rows } };
  }

  return {
    approvalKeyboard,
    backToMainKeyboard,
    booleanOptionKeyboard,
    emptyInlineKeyboard,
    fastKeyboard,
    inlineKeyboard,
    languageKeyboard,
    liveProgressKeyboard,
    localeKeyboard,
    mainPanelKeyboard,
    pathsKeyboard,
    previousPanelFor,
    runtimeCleanupKeyboard,
    runtimeCodexKeyboard,
    runtimeKeyboard,
    runtimeOutputKeyboard,
    runtimeQueueKeyboard,
    runtimeSnapshotKeyboard,
    sandboxKeyboard,
    schemaKeyboard,
    settingsKeyboard,
    settingsSelectionKeyboard,
    standaloneFastSelectionKeyboard,
    standaloneModelSelectionKeyboard,
    standaloneReasoningSelectionKeyboard,
    statusKeyboard,
    timeZoneGroupKeyboard,
    timeZoneKeyboard,
    toolsKeyboard,
    webSearchKeyboard,
    withMenuCloseButton,
    withPreviousPanelButton,
    withSelectionCancel
  };
}
