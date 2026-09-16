import { createMessageFormatter } from "../i18n.js";
import { b, code, escapeHtml } from "../telegram/html.js";
import { TIME_ZONE_GROUPS } from "./preferences.js";

export function formatSettingPanelHtml({ titleText, current, description, text }) {
  const msg = createMessageFormatter(text);
  return [
    b(titleText),
    msg("ui.currentLine", { value1: code(current) }),
    "",
    description
  ].join("\n");
}

export function formatKeyValueHtml(title, rows) {
  return [
    b(title),
    ...rows.map(([key, value]) => `${escapeHtml(key)}: ${code(String(value))}`)
  ].join("\n");
}

export function createRuntimePanelViews({ text, formatText }) {
  const msg = createMessageFormatter(text);
  const t = text;

  function renderMainPanelHtml({ details, options, transport }) {
    return [
      b(msg("ui.codexControl")),
      "",
      msg("ui.threadLine", { value1: code(details.threadId || msg("ui.notStarted")) }),
      msg("ui.transportLine", { value1: code(transport) }),
      msg("ui.activeTurnLine", { value1: code(details.active ? msg("ui.yes") : msg("ui.no")) }),
      msg("ui.queueLine", { value1: code(msg("ui.pendingModePausedLine", { value1: details.queued, value2: details.queueMode, value3: details.queuePaused ? msg("ui.yes") : msg("ui.no") })) }),
      msg("ui.modelLine", { value1: code(options.model || msg("ui.default")) }),
      msg("ui.thinkingLine", { value1: code(options.modelReasoningEffort) }),
      msg("ui.workdirLine", { value1: code(options.workingDirectory) }),
      "",
      t("mainInstruction")
    ].join("\n");
  }

  function renderSettingsPanelHtml(optionsHtml) {
    return [
      b(msg("ui.codexSettings")),
      "",
      optionsHtml,
      "",
      t("settingsInstruction")
    ].join("\n");
  }

  function renderFastPanelHtml(statusHtml) {
    return `${statusHtml}\n\n${t("fastInstruction")}`;
  }

  function renderSettingPanelHtml(title, current, description) {
    return formatSettingPanelHtml({
      titleText: formatText("settingPanelTitle", { title }),
      current,
      text,
      description
    });
  }

  function renderPathsPanelHtml(options) {
    return [
      b(t("pathsTitle")),
      msg("ui.workdirLine", { value1: code(options.workingDirectory) }),
      msg("ui.additionalDirsLine", { value1: code((options.additionalDirectories ?? []).join(", ") || msg("ui.none")) }),
      "",
      t("pathsDirect"),
      t("pathsButtons")
    ].join("\n");
  }

  function renderSchemaPanelHtml(enabled) {
    return [
      b(msg("ui.structuredOutputSchema")),
      msg("ui.currentLine", { value1: code(enabled ? msg("ui.enabled") : msg("ui.disabled")) }),
      "",
      t("schemaDirect"),
      t("schemaButtons")
    ].join("\n");
  }

  function renderLiveProgressPanelHtml({ options, mode, intervalSeconds }) {
    return [
      b(msg("ui.liveProgress")),
      msg("ui.enabledLine", { value1: code(options.liveProgressEnabled) }),
      msg("ui.sourceLine", { value1: code(options.liveProgressSource) }),
      msg("ui.deletePolicyLine", { value1: code(options.liveProgressDeletePolicy) }),
      msg("ui.modeLine", { value1: code(mode) }),
      msg("ui.intervalLine", { value1: code(`${intervalSeconds}s`) }),
      "",
      `${code(msg("ui.agent"))}: ${t("liveAgent")}`,
      `${code(msg("ui.activity"))}: ${t("liveActivity")}`,
      `${code(msg("ui.both"))}: ${t("liveBoth")}`,
      `${code(msg("ui.never"))}: ${t("liveNever")}`
    ].join("\n");
  }

  function renderRuntimePanelHtml(summaryHtml) {
    return [
      b(t("runtimeTitle")),
      "",
      summaryHtml,
      "",
      t("runtimeDescription")
    ].join("\n");
  }

  function renderToolsPanelHtml({ threadId, savedChats, pendingTurns }) {
    return [
      b(msg("ui.codexTools")),
      "",
      msg("ui.threadLine", { value1: code(threadId || msg("ui.notStarted")) }),
      msg("ui.savedChatsLine", { value1: code(savedChats) }),
      msg("ui.pendingTurnsLine", { value1: code(pendingTurns) }),
      "",
      t("toolsInstruction")
    ].join("\n");
  }

  function renderTimeZoneGroupPanelHtml(groupId, currentTimeZone) {
    const group = TIME_ZONE_GROUPS.find(([id]) => id === groupId);
    if (!group) {
      return renderSettingPanelHtml(t("timeZoneTitle"), currentTimeZone, t("timeZoneDescription"));
    }
    const [, emoji, label] = group;
    const description = groupId === "utc" ? t("timeZoneUtcDescription") : t("timeZoneRegionDescription");
    return renderSettingPanelHtml(
      `${t("timeZoneTitle")} · ${emoji} ${t(label)}`,
      currentTimeZone,
      description
    );
  }

  return {
    renderFastPanelHtml,
    renderLiveProgressPanelHtml,
    renderMainPanelHtml,
    renderPathsPanelHtml,
    renderRuntimePanelHtml,
    renderSchemaPanelHtml,
    renderSettingPanelHtml,
    renderSettingsPanelHtml,
    renderTimeZoneGroupPanelHtml,
    renderToolsPanelHtml
  };
}
