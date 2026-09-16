import { createMessageFormatter } from "../i18n.js";
import path from "node:path";
import { resolveAutoCompactTokenLimit } from "../codex/compact.js";
import { b, code, pre } from "../telegram/html.js";

export function createOperationsPresenter({
  settings,
  threadCache,
  chats,
  queue,
  telegram,
  formatting,
  commands,
  text
}) {
  const msg = createMessageFormatter(text);
  function formatConfigHtml() {
    const config = settings.config;
    return formatting.keyValue(msg("ui.codexRuntimeConfig"), [
      [msg("ui.workerMode"), settings.runtimeValue("codexWorkerMode")],
      [msg("ui.workerSocket"), config.codexWorkerSocket],
      [msg("ui.workerEventPoll"), `${settings.runtimeValue("codexWorkerEventPollMs")}ms`],
      [msg("ui.transport"), settings.runtimeValue("codexTransport")],
      [msg("ui.codexPathOverride"), config.codexPath],
      [msg("ui.appServerDirectTimeout"), `${settings.runtimeValue("codexAppServerDirectTimeoutMs")}ms`],
      [msg("ui.baseUrl"), config.codexBaseUrl || msg("ui.default")],
      [msg("ui.apiKey"), config.codexApiKey ? msg("ui.set") : msg("ui.defaultAuth")],
      [msg("ui.config"), config.codexConfig ? msg("ui.set") : msg("ui.none")],
      [msg("ui.autoCompactTokenLimit"), resolveAutoCompactTokenLimit(config) || msg("ui.default")],
      [msg("ui.compactStrength"), config.codexCompactStrength],
      [
        msg("ui.contextGuard"),
        config.codexContextGuardEnabled
          ? msg("ui.minTokensLine", { value1: config.codexContextCompactThresholdPercent, value2: config.codexContextMinRemainingTokens })
          : msg("ui.off")
      ],
      [
        msg("ui.restartRecovery"),
        config.botRestartRecoveryEnabled
          ? msg("ui.onDelaySDrainSLine", { value1: config.botRestartDelaySeconds, value2: config.botRestartDrainTimeoutSeconds })
          : msg("ui.off")
      ],
      [
        msg("ui.recoveryBackfillPoll"),
        config.botRecoveryBackfillPollMs > 0 ? `${config.botRecoveryBackfillPollMs}ms` : msg("ui.off")
      ],
      [msg("ui.recoveryDir"), config.botRecoveryDir],
      [msg("ui.env"), config.codexEnv ? msg("ui.set") : msg("ui.inheritProcessEnv")],
      [msg("ui.modelsCacheFile"), config.codexModelsCacheFile]
    ]);
  }

  function formatUploadCleanupPlanHtml(plan, record = null) {
    const lines = [
      b(msg("ui.uploadCleanupPlan")),
      msg("ui.modeLine2", { value1: code(plan.dryRun ? msg("ui.dryRun") : msg("ui.confirm")) }),
      msg("ui.uploadDirLine", { value1: code(settings.config.uploadDir) }),
      msg("ui.retentionLine", { value1: code(`${plan.retentionDays}d`) }),
      msg("ui.maxBytesLine", { value1: code(plan.maxBytes > 0 ? formatting.bytes(plan.maxBytes) : msg("ui.off")) }),
      msg("ui.totalUploadsLine", { value1: code(`${formatting.count(plan.candidates.length + plan.preserved.length)} / ${formatting.bytes(plan.totalBytes)}`) }),
      msg("ui.cleanupCandidatesLine", { value1: code(`${formatting.count(plan.candidates.length)} / ${formatting.bytes(plan.candidateBytes)}`) })
    ];
    if (record) {
      lines.push(msg("ui.planIdLine", { value1: code(record.id) }));
      lines.push(msg("ui.expiresLine", { value1: code(formatting.dateTime(record.expiresAt)) }));
    }
    lines.push(
      msg("ui.noFilesAreDeletedUntilTheButtonIsLine", { value1: code(msg("ui.confirmUploadCleanup")) })
    );
    for (const candidate of plan.candidates.slice(0, 8)) {
      lines.push(
        `- ${code(path.basename(candidate.path))}: ${code(formatting.bytes(candidate.bytes ?? 0))}`
      );
    }
    return lines.join("\n");
  }

  function formatUploadCleanupProcessingHtml(record) {
    return [
      b(msg("ui.uploadCleanupProcessing")),
      msg("ui.planIdLine", { value1: code(record.id) }),
      msg("ui.candidatesLine", { value1: code(record.plan.candidates.length) })
    ].join("\n");
  }

  function formatUploadCleanupResultHtml(plan, result) {
    return formatting.keyValue(msg("ui.uploadCleanupComplete"), [
      [msg("maintenanceCandidates"), plan.candidates.length],
      [msg("ui.candidateBytes"), formatting.bytes(plan.candidateBytes)],
      [msg("ui.deleted"), result.deleted],
      [msg("ui.skipped"), result.skipped],
      [msg("ui.errors"), result.errors.length]
    ]);
  }

  function formatPrefsHtml(chatKey) {
    const chat = chats.get(chatKey);
    const options = chats.getEffectiveOptions(chatKey);
    return formatting.keyValue(msg("ui.chatPreferences"), [
      [msg("ui.thread"), chat.threadId || threadCache.get(chatKey)?.id || msg("ui.notStarted")],
      [msg("ui.model"), options.model || msg("ui.default")],
      [msg("ui.thinking"), options.modelReasoningEffort],
      [msg("ui.fast"), options.serviceTier === "fast" ? msg("ui.on") : msg("ui.off")],
      [msg("ui.queueMode"), queue.mode(chatKey)],
      [msg("ui.workdir"), options.workingDirectory],
      [msg("ui.sandbox"), options.sandboxMode],
      [msg("ui.approval"), options.approvalPolicy],
      [msg("ui.websearch"), options.webSearchMode],
      [msg("ui.network"), formatting.optional(options.networkAccessEnabled)],
      [msg("ui.stream"), options.streamEvents],
      [
        msg("ui.liveProgress2"),
        options.liveProgressEnabled
          ? `${options.liveProgressSource}, ${options.liveProgressDeletePolicy}`
          : msg("ui.off")
      ],
      [msg("ui.schema"), chat.outputSchema ? msg("ui.enabled") : msg("ui.disabled")],
      [msg("ui.additionalDirs"), (options.additionalDirectories ?? []).join(", ") || msg("ui.none")],
      [msg("ui.reset"), "/prefs_reset"]
    ]);
  }

  function formatWhoamiHtml(ctx) {
    const userId = String(ctx.from?.id ?? "");
    return formatting.keyValue(msg("ui.telegramIdentity"), [
      [msg("ui.allowed"), settings.config.allowedUserIds.has(userId) ? msg("ui.yes") : msg("ui.no")],
      [msg("ui.userId"), userId || msg("ui.unknown")],
      [msg("ui.chatId"), String(ctx.chat?.id ?? msg("ui.unknown"))],
      [msg("ui.chatType"), ctx.chat?.type || msg("ui.unknown")],
      [msg("ui.username"), ctx.from?.username ? `@${ctx.from.username}` : msg("ui.none")],
      [
        msg("ui.name"),
        [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(" ") || msg("ui.unknown")
      ],
      [msg("ui.language"), ctx.from?.language_code || msg("ui.unknown")]
    ]);
  }

  async function formatLogsHtml(ctx, overrideArg = null) {
    const arg = (overrideArg ?? telegram.getCommandArgs(ctx).trim()).toLowerCase();
    let lines = 40;
    let priorityArgs = [];
    if (arg === "error" || arg === "errors") {
      priorityArgs = ["-p", "warning"];
    } else if (arg) {
      const parsed = Number(arg);
      if (!Number.isInteger(parsed) || parsed < 1) {
        return msg("ui.usageOrLine", { value1: code("/logs [lines]"), value2: code("/logs_error") });
      }
      lines = Math.min(parsed, settings.runtimeValue("logsMaxLines"));
    }
    const result = await commands.readOutput(
      "journalctl",
      ["--user", "-u", "codex-telegram-bot.service", ...priorityArgs, "-n", String(lines), "--no-pager"],
      5000
    );
    if (!result.ok) return `${b(msg("ui.logsUnavailable"))}\n${code(result.error)}`;
    let body = formatting.redactText(result.output)
      .split("\n")
      .slice(-settings.runtimeValue("logsMaxLines"))
      .join("\n");
    const maxBodyLength = Math.max(500, settings.runtimeValue("maxTelegramChars") - 300);
    if (body.length > maxBodyLength) {
      body = msg("ui.truncatedLine", { value1: body.slice(-maxBodyLength) });
    }
    return `${b(msg("ui.recentBotLogs"))}\n${pre(body || msg("ui.noLogs"))}`;
  }

  return {
    formatConfigHtml,
    formatLogsHtml,
    formatPrefsHtml,
    formatUploadCleanupPlanHtml,
    formatUploadCleanupProcessingHtml,
    formatUploadCleanupResultHtml,
    formatWhoamiHtml
  };
}
