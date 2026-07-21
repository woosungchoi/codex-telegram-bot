import { b, code, escapeHtml } from "../telegram/html.js";
import { TIME_ZONE_GROUPS } from "./preferences.js";

export function formatSettingPanelHtml({ titleText, current, description }) {
  return [
    b(titleText),
    `Current: ${code(current)}`,
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
  const t = text;

  function renderMainPanelHtml({ details, options, transport }) {
    return [
      b("Codex Control"),
      "",
      `Thread: ${code(details.threadId || "not started")}`,
      `Transport: ${code(transport)}`,
      `Active turn: ${code(details.active ? "yes" : "no")}`,
      `Queue: ${code(`${details.queued} pending, mode=${details.queueMode}, paused=${details.queuePaused ? "yes" : "no"}`)}`,
      `Model: ${code(options.model || "default")}`,
      `Thinking: ${code(options.modelReasoningEffort)}`,
      `Workdir: ${code(options.workingDirectory)}`,
      "",
      t("mainInstruction")
    ].join("\n");
  }

  function renderSettingsPanelHtml(optionsHtml) {
    return [
      b("Codex Settings"),
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
      description
    });
  }

  function renderPathsPanelHtml(options) {
    return [
      b(t("pathsTitle")),
      `Workdir: ${code(options.workingDirectory)}`,
      `Additional dirs: ${code((options.additionalDirectories ?? []).join(", ") || "none")}`,
      "",
      t("pathsDirect"),
      t("pathsButtons")
    ].join("\n");
  }

  function renderSchemaPanelHtml(enabled) {
    return [
      b("Structured Output Schema"),
      `Current: ${code(enabled ? "enabled" : "disabled")}`,
      "",
      t("schemaDirect"),
      t("schemaButtons")
    ].join("\n");
  }

  function renderLiveProgressPanelHtml({ options, mode, intervalSeconds }) {
    return [
      b("Live Progress"),
      `Enabled: ${code(options.liveProgressEnabled)}`,
      `Source: ${code(options.liveProgressSource)}`,
      `Delete policy: ${code(options.liveProgressDeletePolicy)}`,
      `Mode: ${code(mode)}`,
      `Interval: ${code(`${intervalSeconds}s`)}`,
      "",
      `${code("agent")}: ${t("liveAgent")}`,
      `${code("activity")}: ${t("liveActivity")}`,
      `${code("both")}: ${t("liveBoth")}`,
      `${code("never")}: ${t("liveNever")}`
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
      b("Codex Tools"),
      "",
      `Thread: ${code(threadId || "not started")}`,
      `Saved chats: ${code(savedChats)}`,
      `Pending turns: ${code(pendingTurns)}`,
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
      `${t("timeZoneTitle")} · ${emoji} ${label}`,
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
