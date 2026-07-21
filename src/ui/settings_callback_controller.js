import { b, code } from "../telegram/html.js";

const RUNTIME_SETTING_KEYS = Object.freeze({
  runtime_reactions: "telegramReactionsEnabled",
  runtime_answerformat: "telegramFormatCodexAnswers",
  runtime_completionnotice: "telegramCompletionNoticeSeconds",
  runtime_pendingmax: "telegramPendingTurnsMax",
  runtime_pendingage: "telegramPendingTurnMaxAgeSeconds",
  runtime_workermode: "codexWorkerMode",
  runtime_workerpoll: "codexWorkerEventPollMs",
  runtime_codextransport: "codexTransport",
  runtime_appservertimeout: "codexAppServerDirectTimeoutMs",
  runtime_liveprogressmode: "telegramLiveProgressMode",
  runtime_liveprogressinterval: "telegramLiveProgressIntervalMs",
  runtime_cleanup: "cleanupEnabled",
  runtime_cleanuptime: "cleanupNotifyTime",
  runtime_cleanupretention: "cleanupRetentionDays",
  runtime_cleanupquarantine: "cleanupQuarantineDays",
  runtime_cleanupttl: "cleanupPlanTtlHours",
  runtime_snapshot: "snapshotEnabled",
  runtime_snapshottime: "snapshotNotifyTime",
  runtime_snapshotretention: "snapshotRetentionDays",
  runtime_logsmax: "logsMaxLines",
  runtime_maxchars: "maxTelegramChars",
  runtime_progressedit: "progressEditIntervalMs"
});

export function createSettingsCallbackController({
  settings,
  state,
  chats,
  queue,
  panels,
  keyboards,
  telegram,
  localization,
  preferences,
  diagnostics,
  worker,
  formatting,
  commands
}) {
  async function handleQueueButton(ctx, action, value) {
    const chatKey = telegram.getChatKey(ctx);
    await queue.pruneExpired(chatKey, ctx);
    if (action === "pause") {
      await queue.setPaused(chatKey, true);
      await telegram.editOrReplyHtml(
        ctx,
        `${b(localization.text("queuePausedTitle"))}\n${localization.text("queuePausedDetail")}\n\n${queue.format(chatKey)}`,
        keyboards.queue(chatKey)
      );
      return;
    }
    if (action === "resume") {
      await queue.setPaused(chatKey, false);
      await queue.startDrain(chatKey, ctx);
      await telegram.editOrReplyHtml(
        ctx,
        `${b(localization.text("queueResumedTitle"))}\n\n${queue.format(chatKey)}`,
        keyboards.queue(chatKey)
      );
      return;
    }
    if (action === "mode") {
      if (!settings.validQueueModes.has(value)) {
        await telegram.editOrReplyHtml(
          ctx,
          `${b("Invalid queue mode")}\n${code(value || "empty")}`,
          keyboards.queue(chatKey)
        );
        return;
      }
      await queue.setMode(chatKey, value);
      await telegram.editOrReplyHtml(
        ctx,
        `${b(localization.text("queueUpdatedTitle"))}\n\n${queue.format(chatKey)}`,
        keyboards.queue(chatKey)
      );
      return;
    }
    if (action === "clear") {
      await telegram.editOrReplyHtml(
        ctx,
        `${b(localization.text("queueClearConfirmTitle"))}\n${localization.text("queueClearConfirmBody")}`,
        keyboards.withClose(keyboards.inline([
          [
            { text: localization.text("clearAll"), callback_data: "confirm:q_clear" },
            { text: localization.text("cancel"), callback_data: "p:queue" }
          ],
          [{ text: `← ${localization.text("back")}`, callback_data: "p:queue" }]
        ]))
      );
    }
  }

  async function handleSettingButton(ctx, key, value) {
    const chatKey = telegram.getChatKey(ctx);
    if (await telegram.rejectCallbackIfActive(ctx, chatKey)) return;
    try {
      if (key === "fast") {
        await chats.setOption(chatKey, "serviceTier", value === "on" ? "fast" : "default");
      } else if (key === "sandbox") {
        await chats.setOption(chatKey, "sandboxMode", mapSandboxValue(value));
      } else if (key === "approval") {
        await chats.setOption(chatKey, "approvalPolicy", value.replaceAll("_", "-"));
      } else if (key === "web") {
        await chats.setOption(chatKey, "webSearchMode", value);
      } else if (key === "network") {
        await chats.setOption(chatKey, "networkAccessEnabled", value);
      } else if (key === "stream") {
        await chats.setOption(chatKey, "streamEvents", value);
      } else if (key === "liveprogress") {
        await chats.setOption(chatKey, "liveProgressEnabled", value);
      } else if (key === "liveprogresssource") {
        await chats.setOption(chatKey, "liveProgressSource", value);
      } else if (key === "liveprogressdelete") {
        await chats.setOption(chatKey, "liveProgressDeletePolicy", value);
      } else if (key.startsWith("runtime_")) {
        await settings.updateRuntimeSetting(
          runtimeSettingKey(key),
          runtimeSettingValue(key, value)
        );
        await telegram.editOrReplyHtml(
          ctx,
          `${b(localization.text("runtimeUpdated"))}\n\n${panels.runtimeHtml()}`,
          keyboards.runtime()
        );
        return;
      } else if (key === "skipgit") {
        await chats.setOption(chatKey, "skipGitRepoCheck", value);
      } else if (key === "workdir") {
        await chats.setOption(chatKey, "workingDirectory", value);
      } else if (key === "language") {
        state.ui.language = preferences.parseLanguage(value);
        await settings.saveState();
        await telegram.editOrReplyHtml(
          ctx,
          `${b(localization.text("languageUpdated"))}\n\n${panels.settingsHtml(chatKey)}`,
          keyboards.settings()
        );
        await commands.register().catch((error) => {
          console.warn(
            "setMyCommands after language update failed:",
            telegram.summarizeError(error)
          );
        });
        return;
      } else if (key === "timezone") {
        state.ui.timeZone = value === "default"
          ? settings.config.telegramTimeZone
          : choiceValue(preferences.timeZones, value, "time zone", preferences.parseTimeZone);
        await settings.saveState();
        await telegram.editOrReplyHtml(
          ctx,
          `${b(localization.text("timeZoneUpdated"))}\n\n${panels.settingsHtml(chatKey)}`,
          keyboards.settings()
        );
        return;
      } else if (key === "locale") {
        state.ui.locale = value === "default"
          ? settings.config.telegramLocale
          : choiceValue(preferences.locales, value, "locale", preferences.parseLocale);
        await settings.saveState();
        await telegram.editOrReplyHtml(
          ctx,
          `${b(localization.text("localeUpdated"))}\n\n${panels.settingsHtml(chatKey)}`,
          keyboards.settings()
        );
        return;
      } else if (key === "dirs" && value === "clear") {
        delete chats.get(chatKey).options.additionalDirectories;
        chats.invalidateThreadCache(chatKey);
      } else if (key === "schema" && value === "off") {
        delete chats.get(chatKey).outputSchema;
      } else {
        throw new Error(`Unknown setting action: ${key}:${value}`);
      }
    } catch (error) {
      await telegram.editOrReplyHtml(
        ctx,
        `${b(localization.text("settingFailure"))}\n${code(error instanceof Error ? error.message : String(error))}`,
        keyboards.settings()
      );
      return;
    }
    await settings.saveState();
    await telegram.editOrReplyHtml(
      ctx,
      `${b(localization.text("settingUpdated"))}\n\n${panels.settingsHtml(chatKey)}`,
      keyboards.settings()
    );
  }

  async function handleAppServerStatusButton(ctx) {
    const rows = [
      ["transport", settings.runtimeValue("codexTransport")],
      ["direct args", diagnostics.appServerDirectArgs().join(" ")],
      ["timeout", `${settings.runtimeValue("codexAppServerDirectTimeoutMs")}ms`]
    ];
    try {
      const result = await diagnostics.readCommandOutput(
        settings.config.codexPath,
        ["app-server", "--help"],
        settings.runtimeValue("codexAppServerDirectTimeoutMs")
      );
      const supportsStdio = result.ok && result.output.includes("--stdio");
      rows.push(["status", result.ok ? (supportsStdio ? "available" : "unsupported") : "failed"]);
      rows.push([
        "help",
        formatting.truncate(
          supportsStdio ? result.output : result.output || result.error || "missing --stdio support",
          supportsStdio ? 120 : 180
        )
      ]);
    } catch (error) {
      rows.push(["status", "failed"]);
      rows.push(["error", formatting.truncate(error instanceof Error ? error.message : String(error), 240)]);
    }
    await telegram.editOrReplyHtml(
      ctx,
      formatting.keyValue("Codex app-server direct:", rows),
      keyboards.runtimeCodex()
    );
  }

  async function handleWorkerStatusButton(ctx) {
    const rows = [
      ["worker mode", settings.runtimeValue("codexWorkerMode")],
      ["socket", settings.config.codexWorkerSocket],
      ["poll", `${settings.runtimeValue("codexWorkerEventPollMs")}ms`]
    ];
    try {
      const status = await worker.getClient().status();
      rows.push(["status", status.status || "ok"]);
      rows.push(["active jobs", status.activeJobs?.length ?? 0]);
      rows.push(["running jobs", status.runningJobIds?.length ?? 0]);
    } catch (error) {
      rows.push(["status", "failed"]);
      rows.push(["error", formatting.truncate(error instanceof Error ? error.message : String(error), 240)]);
    }
    await telegram.editOrReplyHtml(
      ctx,
      formatting.keyValue("Codex worker:", rows),
      keyboards.runtimeCodex()
    );
  }

  return {
    handleAppServerStatusButton,
    handleQueueButton,
    handleSettingButton,
    handleWorkerStatusButton
  };
}

export function mapSandboxValue(value) {
  if (value === "ro") return "read-only";
  if (value === "ww") return "workspace-write";
  if (value === "danger") return "danger-full-access";
  return value;
}

export function runtimeSettingKey(actionKey) {
  const key = RUNTIME_SETTING_KEYS[actionKey];
  if (!key) throw new Error(`Unknown runtime action: ${actionKey}`);
  return key;
}

export function runtimeSettingValue(actionKey, value) {
  if (value === "korean_brief") return "korean-brief";
  if (actionKey === "runtime_cleanuptime" || actionKey === "runtime_snapshottime") {
    return value.replaceAll("_", ":");
  }
  return value;
}

function choiceValue(choices, id, label, parser) {
  const choice = choices.find(([choiceId]) => choiceId === id);
  if (!choice) throw new Error(`Unknown ${label}: ${id}`);
  return parser(choice[2]);
}
