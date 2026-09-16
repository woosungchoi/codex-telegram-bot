import { createMessageFormatter, LANGUAGE_CHOICES } from "../i18n.js";
import {
  LOCALE_CHOICES,
  TIME_ZONE_GROUPS,
  formatTimeZoneChoiceLabel,
  timeZoneChoicesForGroup
} from "./preferences.js";
import { chunkButtons, inlineKeyboard } from "./keyboard_helpers.js";
import { booleanOptionKeyboardRows } from "./selection_keyboards.js";

export function createSettingsKeyboardViews({
  text,
  currentLanguage,
  currentTimeZone,
  currentLocale,
  withMenuCloseButton
}) {
  const msg = createMessageFormatter(text);
  const t = text;

  function settingsKeyboard() {
    return withMenuCloseButton(inlineKeyboard([
      [
        { text: t("model"), callback_data: "p:settings_model" },
        { text: msg("ui.thinking2"), callback_data: "p:settings_reasoning" }
      ],
      [
        { text: msg("ui.fast2"), callback_data: "p:settings_fast" },
        { text: msg("ui.sandbox2"), callback_data: "p:settings_sandbox" }
      ],
      [
        { text: msg("ui.approval2"), callback_data: "p:settings_approval" },
        { text: msg("ui.webSearch"), callback_data: "p:settings_web" }
      ],
      [
        { text: msg("ui.network2"), callback_data: "p:settings_network" },
        { text: msg("ui.stream2"), callback_data: "p:settings_stream" }
      ],
      [
        { text: msg("ui.liveProgress"), callback_data: "p:settings_live_progress" }
      ],
      [
        { text: t("runtime"), callback_data: "p:settings_runtime" }
      ],
      [
        { text: msg("ui.gitCheck"), callback_data: "p:settings_git" },
        { text: msg("ui.paths"), callback_data: "p:settings_paths" }
      ],
      [
        { text: msg("ui.schema2"), callback_data: "p:settings_schema" },
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
      [{ role: "back", text: `← ${t("back")}`, callback_data: "p:main" }]
    ]));
  }

  function sandboxKeyboard() {
    return inlineKeyboard([
      [
        { text: msg("ui.default"), callback_data: "set:sandbox:default" },
        { text: msg("ui.readOnly"), callback_data: "set:sandbox:ro" }
      ],
      [
        { text: msg("ui.workspaceWrite"), callback_data: "set:sandbox:ww" },
        { text: msg("ui.dangerFullAccess"), callback_data: "set:sandbox:danger" }
      ],
      [{ text: t("settings"), callback_data: "p:settings" }]
    ]);
  }

  function approvalKeyboard() {
    return inlineKeyboard([
      [
        { text: msg("ui.default"), callback_data: "set:approval:default" },
        { text: msg("ui.never"), callback_data: "set:approval:never" }
      ],
      [
        { text: msg("ui.onRequest"), callback_data: "set:approval:on_request" },
        { text: msg("ui.onFailure"), callback_data: "set:approval:on_failure" }
      ],
      [
        { text: msg("ui.untrusted"), callback_data: "set:approval:untrusted" },
        { text: t("settings"), callback_data: "p:settings" }
      ]
    ]);
  }

  function webSearchKeyboard() {
    return inlineKeyboard([
      [
        { text: msg("ui.default"), callback_data: "set:web:default" },
        { text: msg("ui.disabled"), callback_data: "set:web:disabled" }
      ],
      [
        { text: msg("ui.cached"), callback_data: "set:web:cached" },
        { text: msg("ui.live"), callback_data: "set:web:live" }
      ],
      [{ text: t("settings"), callback_data: "p:settings" }]
    ]);
  }

  function booleanOptionKeyboard(key) {
    return inlineKeyboard(booleanOptionKeyboardRows(key, t("settings"), text));
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
        { text: msg("ui.brief"), callback_data: "set:runtime_liveprogressmode:brief" },
        { text: msg("ui.legacyKo"), callback_data: "set:runtime_liveprogressmode:korean_brief" },
        { text: t("default"), callback_data: "set:runtime_liveprogressmode:default" }
      ],
      [
        { text: msg("units.seconds", { count: 10 }), callback_data: "set:runtime_liveprogressinterval:10" },
        { text: msg("units.seconds", { count: 30 }), callback_data: "set:runtime_liveprogressinterval:30" },
        { text: msg("units.seconds", { count: 60 }), callback_data: "set:runtime_liveprogressinterval:60" },
        { text: t("default"), callback_data: "set:runtime_liveprogressinterval:default" }
      ],
      [{ text: t("settings"), callback_data: "p:settings" }, { text: t("main"), callback_data: "p:main" }]
    ]);
  }

  function pathsKeyboard() {
    return inlineKeyboard([
      [
        { text: msg("ui.workdirDefault"), callback_data: "set:workdir:default" },
        { text: t("clearDirs"), callback_data: "set:dirs:clear" }
      ],
      [{ text: t("settings"), callback_data: "p:settings" }]
    ]);
  }

  function schemaKeyboard() {
    return inlineKeyboard([[
      { text: t("schemaOff"), callback_data: "set:schema:off" },
      { text: t("settings"), callback_data: "p:settings" }
    ]]);
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

  function timeZoneKeyboard() {
    return inlineKeyboard([
      ...chunkButtons(TIME_ZONE_GROUPS.map(([id, emoji, label]) => ({
        text: `${emoji} ${t(label)}`,
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
          ? `✅ ${formatTimeZoneChoiceLabel(label, timeZone, text)}`
          : formatTimeZoneChoiceLabel(label, timeZone, text),
        callback_data: `set:timezone:${id}`
      })), columns),
      [{ text: t("settings"), callback_data: "p:settings" }, { text: t("main"), callback_data: "p:main" }],
      [{ role: "back", text: `← ${t("back")}`, callback_data: "p:settings_timezone" }]
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

  return {
    approvalKeyboard,
    booleanOptionKeyboard,
    languageKeyboard,
    liveProgressKeyboard,
    localeKeyboard,
    pathsKeyboard,
    sandboxKeyboard,
    schemaKeyboard,
    settingsKeyboard,
    timeZoneGroupKeyboard,
    timeZoneKeyboard,
    webSearchKeyboard
  };
}
