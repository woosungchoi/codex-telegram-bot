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
  commands
}) {
  function formatConfigHtml() {
    const config = settings.config;
    return formatting.keyValue("Codex runtime config:", [
      ["worker mode", settings.runtimeValue("codexWorkerMode")],
      ["worker socket", config.codexWorkerSocket],
      ["worker event poll", `${settings.runtimeValue("codexWorkerEventPollMs")}ms`],
      ["transport", settings.runtimeValue("codexTransport")],
      ["codexPathOverride", config.codexPath],
      ["app-server direct timeout", `${settings.runtimeValue("codexAppServerDirectTimeoutMs")}ms`],
      ["baseUrl", config.codexBaseUrl || "default"],
      ["apiKey", config.codexApiKey ? "set" : "default auth"],
      ["config", config.codexConfig ? "set" : "none"],
      ["auto compact token limit", resolveAutoCompactTokenLimit(config) || "default"],
      ["compact strength", config.codexCompactStrength],
      [
        "context guard",
        config.codexContextGuardEnabled
          ? `${config.codexContextCompactThresholdPercent}% / min ${config.codexContextMinRemainingTokens} tokens`
          : "off"
      ],
      [
        "restart recovery",
        config.botRestartRecoveryEnabled
          ? `on, delay ${config.botRestartDelaySeconds}s, drain ${config.botRestartDrainTimeoutSeconds}s`
          : "off"
      ],
      [
        "recovery backfill poll",
        config.botRecoveryBackfillPollMs > 0 ? `${config.botRecoveryBackfillPollMs}ms` : "off"
      ],
      ["recovery dir", config.botRecoveryDir],
      ["env", config.codexEnv ? "set" : "inherit process.env"],
      ["modelsCacheFile", config.codexModelsCacheFile]
    ]);
  }

  function formatUploadCleanupPlanHtml(plan, record = null) {
    const lines = [
      b("Upload cleanup plan"),
      `mode: ${code(plan.dryRun ? "dry-run" : "confirm")}`,
      `upload dir: ${code(settings.config.uploadDir)}`,
      `retention: ${code(`${plan.retentionDays}d`)}`,
      `max bytes: ${code(plan.maxBytes > 0 ? formatting.bytes(plan.maxBytes) : "off")}`,
      `total uploads: ${code(`${formatting.count(plan.candidates.length + plan.preserved.length)} / ${formatting.bytes(plan.totalBytes)}`)}`,
      `cleanup candidates: ${code(`${formatting.count(plan.candidates.length)} / ${formatting.bytes(plan.candidateBytes)}`)}`
    ];
    if (record) {
      lines.push(`plan id: ${code(record.id)}`);
      lines.push(`expires: ${code(formatting.dateTime(record.expiresAt))}`);
    }
    lines.push(
      `No files are deleted until the ${code("Confirm upload cleanup")} button is pressed.`
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
      b("Upload cleanup processing"),
      `plan id: ${code(record.id)}`,
      `candidates: ${code(record.plan.candidates.length)}`
    ].join("\n");
  }

  function formatUploadCleanupResultHtml(plan, result) {
    return formatting.keyValue("Upload cleanup complete", [
      ["candidates", plan.candidates.length],
      ["candidate bytes", formatting.bytes(plan.candidateBytes)],
      ["deleted", result.deleted],
      ["skipped", result.skipped],
      ["errors", result.errors.length]
    ]);
  }

  function formatPrefsHtml(chatKey) {
    const chat = chats.get(chatKey);
    const options = chats.getEffectiveOptions(chatKey);
    return formatting.keyValue("Chat preferences:", [
      ["thread", chat.threadId || threadCache.get(chatKey)?.id || "not started"],
      ["model", options.model || "default"],
      ["thinking", options.modelReasoningEffort],
      ["fast", options.serviceTier === "fast" ? "on" : "off"],
      ["queue mode", queue.mode(chatKey)],
      ["workdir", options.workingDirectory],
      ["sandbox", options.sandboxMode],
      ["approval", options.approvalPolicy],
      ["websearch", options.webSearchMode],
      ["network", formatting.optional(options.networkAccessEnabled)],
      ["stream", options.streamEvents],
      [
        "live progress",
        options.liveProgressEnabled
          ? `${options.liveProgressSource}, ${options.liveProgressDeletePolicy}`
          : "off"
      ],
      ["schema", chat.outputSchema ? "enabled" : "disabled"],
      ["additional dirs", (options.additionalDirectories ?? []).join(", ") || "none"],
      ["reset", "/prefs_reset"]
    ]);
  }

  function formatWhoamiHtml(ctx) {
    const userId = String(ctx.from?.id ?? "");
    return formatting.keyValue("Telegram identity:", [
      ["allowed", settings.config.allowedUserIds.has(userId) ? "yes" : "no"],
      ["user id", userId || "unknown"],
      ["chat id", String(ctx.chat?.id ?? "unknown")],
      ["chat type", ctx.chat?.type || "unknown"],
      ["username", ctx.from?.username ? `@${ctx.from.username}` : "none"],
      [
        "name",
        [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(" ") || "unknown"
      ],
      ["language", ctx.from?.language_code || "unknown"]
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
        return `Usage: ${code("/logs [lines]")} or ${code("/logs_error")}`;
      }
      lines = Math.min(parsed, settings.runtimeValue("logsMaxLines"));
    }
    const result = await commands.readOutput(
      "journalctl",
      ["--user", "-u", "codex-telegram-bot.service", ...priorityArgs, "-n", String(lines), "--no-pager"],
      5000
    );
    if (!result.ok) return `${b("Logs unavailable")}\n${code(result.error)}`;
    let body = formatting.redactText(result.output)
      .split("\n")
      .slice(-settings.runtimeValue("logsMaxLines"))
      .join("\n");
    const maxBodyLength = Math.max(500, settings.runtimeValue("maxTelegramChars") - 300);
    if (body.length > maxBodyLength) {
      body = `... truncated ...\n${body.slice(-maxBodyLength)}`;
    }
    return `${b("Recent bot logs:")}\n${pre(body || "no logs")}`;
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
