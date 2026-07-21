import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { b, code, pre } from "../telegram/html.js";
import {
  readActiveTurnSnapshots,
  readRecoveryDedupe,
  readRestartMarker
} from "../recovery/state.js";
import { summarizeWorkerDeliveryStatus } from "../worker/delivery.js";

const execFileAsync = promisify(execFile);

export function createRuntimeDiagnostics({
  settings,
  state,
  activeTurns,
  threadCache,
  chats,
  options,
  queue,
  sessions,
  usage,
  models,
  uploads,
  localization,
  formatting,
  packages,
  now = Date.now
}) {
  async function buildStatusDetails(chatKey) {
    const chat = chats.get(chatKey);
    const cached = threadCache.get(chatKey);
    const activeInfo = activeTurns.get(chatKey) ?? null;
    const threadId = chat.threadId || cached?.id || "";
    const fallbackSession = threadId ? null : (await sessions.listRecent(1))[0] ?? null;
    const usageSummary = await usage.buildSummary(chatKey, threadId || fallbackSession?.id || "");
    return {
      threadId,
      active: Boolean(activeInfo),
      activeInfo,
      sideTurns: queue.sideTurnCount(chatKey),
      queued: queue.pending(chatKey).length,
      queuePaused: queue.isPaused(chatKey),
      queueMode: queue.mode(chatKey),
      deliverySummary: summarizeWorkerDeliveryStatus(state.worker?.deliveries, chatKey),
      fallbackSession,
      usageSummary
    };
  }

  function formatStatusHtml(chatKey, details) {
    const lines = [
      b("Codex Telegram Bot"),
      `Checked: ${code(formatting.dateTime(new Date(now())))}`,
      `Thread: ${code(details.threadId || "not started")}`,
      `Active turn: ${code(details.active ? "yes" : "no")}`,
      `Side turns: ${code(details.sideTurns ?? queue.sideTurnCount(chatKey))}`,
      `Queue mode: ${code(details.queueMode ?? queue.mode(chatKey))}`,
      `Queue paused: ${code(details.queuePaused ? "yes" : "no")}`,
      `Queued turns: ${code(details.queued ?? queue.pending(chatKey).length)}`
    ];
    lines.push(...formatPendingDeliveryLines(details.deliverySummary));
    if (details.activeInfo?.currentTurnStartedAt) {
      const elapsed = Math.max(
        0,
        (now() - Date.parse(details.activeInfo.currentTurnStartedAt)) / 1000
      );
      lines.push(
        `Current turn: ${code(formatting.truncate(details.activeInfo.currentText?.replace(/\s+/g, " ") || "unknown", 100))}`,
        `Elapsed: ${code(formatting.duration(elapsed))}`
      );
      if (details.activeInfo.lastProgress) {
        lines.push(
          `Last progress: ${code(formatting.truncate(details.activeInfo.lastProgress, 100))}`,
          `Last progress at: ${code(formatting.dateTime(details.activeInfo.lastProgressAt))}`
        );
      }
    }
    if (details.fallbackSession) {
      lines.push(`Usage source: latest session ${code(details.fallbackSession.id)}`);
    }
    if (details.usageSummary) lines.push("", pre(details.usageSummary));
    lines.push("", options.format(chatKey));
    return lines.join("\n");
  }

  async function formatRecoveryStatusHtml() {
    const config = settings.config;
    const [active, marker, dedupe] = await Promise.all([
      readActiveTurnSnapshots(config.botRecoveryDir),
      readRestartMarker(config.botRecoveryDir),
      readRecoveryDedupe(config.botRecoveryDir)
    ]);
    const activeSnapshots = Object.values(active.turns ?? {});
    const dedupeEntries = Object.entries(dedupe.recentRecoveryKeys ?? {});
    return formatting.keyValue(localization.text("recoveryStatusTitle"), [
      ["enabled", config.botRestartRecoveryEnabled ? "yes" : "no"],
      ["active snapshots", activeSnapshots.length],
      ["restart marker", marker?.restartId || "none"],
      ["marker mode", marker?.mode || "none"],
      ["marker recoveries", marker?.recoveries?.length ?? 0],
      ["stale seconds", config.botRecoveryStaleSeconds],
      ["suspend after", config.botRecoverySuspendAfter],
      [
        "backfill poll",
        config.botRecoveryBackfillPollMs > 0 ? `${config.botRecoveryBackfillPollMs}ms` : "off"
      ],
      ["recent recovery keys", dedupeEntries.length],
      ["last active", activeSnapshots.at(-1)?.chatKey || "none"]
    ]);
  }

  function formatRestartScheduledHtml(marker) {
    const config = settings.config;
    return formatting.keyValue(localization.text("restartScheduledTitle"), [
      ["restart id", marker.restartId],
      ["active recoveries", marker.recoveries.length],
      ["delay", `${config.botRestartDelaySeconds}s`],
      ["drain timeout", `${config.botRestartDrainTimeoutSeconds}s`],
      ["exit code", marker.exitCode]
    ]);
  }

  function formatRestartRecoveredHtml(marker) {
    return formatting.keyValue(localization.text("recoveryStartupNoticeTitle"), [
      ["restart id", marker.restartId],
      ["recoveries", marker.recoveries?.length ?? 0],
      ["mode", marker.mode || "unknown"]
    ]);
  }

  function formatQueueHtml(chatKey) {
    const pending = queue.pending(chatKey);
    const deliveryLines = formatPendingDeliveryLines(
      summarizeWorkerDeliveryStatus(state.worker?.deliveries, chatKey)
    );
    if (pending.length === 0) {
      return [
        b("Codex queue"),
        `Active turn: ${code(activeTurns.has(chatKey) ? "yes" : "no")}`,
        `Side turns: ${code(queue.sideTurnCount(chatKey))}`,
        `Mode: ${code(queue.mode(chatKey))}`,
        `Paused: ${code(queue.isPaused(chatKey) ? "yes" : "no")}`,
        ...deliveryLines,
        localization.text("queueNoTurns")
      ].join("\n");
    }

    const maxAgeSeconds = settings.runtimeValue("telegramPendingTurnMaxAgeSeconds");
    const lines = [
      b("Codex queue"),
      `Active turn: ${code(activeTurns.has(chatKey) ? "yes" : "no")}`,
      `Side turns: ${code(queue.sideTurnCount(chatKey))}`,
      `Mode: ${code(queue.mode(chatKey))}`,
      `Paused: ${code(queue.isPaused(chatKey) ? "yes" : "no")}`,
      `Queued turns: ${code(pending.length)} / ${code(settings.runtimeValue("telegramPendingTurnsMax"))}`,
      ...deliveryLines,
      `Auto expiry: ${code(maxAgeSeconds <= 0 ? "off" : formatting.duration(maxAgeSeconds))}`,
      ""
    ];
    for (const [index, turn] of pending.entries()) {
      const imageSuffix = turn.imagePaths.length > 0 ? `, images:${turn.imagePaths.length}` : "";
      const expires = maxAgeSeconds <= 0
        ? "no expiry"
        : `expires ${formatting.dateTime(turn.expiresAt)}`;
      const kindPrefix = turn.kind === "recovery" ? "[recovery] " : "";
      lines.push(
        `${index + 1}. ${code(`${kindPrefix}${formatting.truncate(turn.text.replace(/\s+/g, " "), 120)}`)} (${code(turn.id)}, ${code(formatting.dateTime(turn.enqueuedAt))}, ${code(expires)}${imageSuffix})`
      );
    }
    lines.push("", localization.text("queueButtonsHelp"));
    return lines.join("\n");
  }

  function formatPendingDeliveryLines(summary) {
    if (!summary || summary.count <= 0) return [];
    const deliveryKey = summary.status === "uncertain"
      ? "telegramDeliveryUncertain"
      : "telegramDeliveryPending";
    const recoveryKey = summary.recovery === "automatic_replay_disabled"
      ? "telegramDeliveryReplayDisabled"
      : summary.recovery === "manual_review_required"
        ? "telegramDeliveryManualReview"
        : "telegramDeliverySafeReplay";
    return [
      localization.text("deliveryCodexExecutionCompleted"),
      localization.formatText(deliveryKey, { count: summary.count }),
      localization.text(recoveryKey)
    ];
  }

  function formatQueueModeHtml(chatKey) {
    return [
      b("Codex queue mode"),
      `Current: ${code(queue.mode(chatKey))}`,
      "",
      `${code("safe")}: ${localization.text("queueModeSafeDescription")}`,
      `${code("interrupt")}: ${localization.text("queueModeInterruptDescription")}`,
      `${code("side")}: ${localization.text("queueModeSideDescription")}`,
      "",
      `Change with ${code("/queue_mode_safe")}, ${code("/queue_mode_interrupt")}, or ${code("/queue_mode_side")}.`
    ].join("\n");
  }

  async function formatDoctorHtml(chatKey) {
    const config = settings.config;
    const [botPackage, sdkPackage, cliVersion, modelsMeta, yoloWrapper] = await Promise.all([
      packages.readJson(settings.packageFile),
      packages.readPackage("@openai/codex-sdk"),
      readCommandOutput(config.codexPath, ["--version"], 5000),
      readModelsCacheMeta(),
      readYoloWrapperStatus()
    ]);
    const effective = options.get(chatKey);
    const declaredSdk = botPackage?.dependencies?.["@openai/codex-sdk"] || "unknown";
    return formatting.keyValue("Codex doctor:", [
      ["bot version", botPackage?.version || "unknown"],
      ["node", process.version],
      ["codex-sdk installed", sdkPackage?.version || "unknown"],
      ["codex-sdk declared", declaredSdk],
      ["codex cli", cliVersion.ok ? cliVersion.output : `error: ${cliVersion.error}`],
      ["codex path", config.codexPath],
      ["yolo wrapper", yoloWrapper],
      ["models cache", modelsMeta.status],
      ["models cache client", modelsMeta.clientVersion],
      ["models cache fetched", modelsMeta.fetchedAt],
      ["fast models", modelsMeta.fastModels],
      ["current model", effective.model || "default"],
      ["current thinking", effective.modelReasoningEffort],
      ["current serviceTier", effective.serviceTier || "default"],
      ["worker mode", settings.runtimeValue("codexWorkerMode")],
      ["worker socket", config.codexWorkerSocket],
      ["codex transport", settings.runtimeValue("codexTransport")],
      ["app-server direct timeout", `${settings.runtimeValue("codexAppServerDirectTimeoutMs")}ms`],
      [
        "recovery backfill poll",
        config.botRecoveryBackfillPollMs > 0 ? `${config.botRecoveryBackfillPollMs}ms` : "off"
      ],
      ["upgrade smoke test", "/status -> /model -> /fast_status -> message -> /new -> /resume_last"]
    ]);
  }

  async function formatHealthHtml() {
    const config = settings.config;
    const memory = process.memoryUsage();
    const [
      stateCheck,
      backupCheck,
      workdirDisk,
      stateDisk,
      serviceStatus,
      workerServiceStatus,
      uploadPlan
    ] = await Promise.all([
      checkStateReadWrite(),
      checkDirectoryWritable(config.backupDir),
      getDiskSummary(config.codexWorkdir),
      getDiskSummary(path.dirname(config.stateFile)),
      readCommandOutput("systemctl", ["--user", "is-active", "codex-telegram-bot.service"], 3000),
      readCommandOutput("systemctl", ["--user", "is-active", "codex-telegram-worker.service"], 3000),
      uploads.createCleanupPlan({ dryRun: true }).catch(() => null)
    ]);
    return formatting.keyValue("Bot health:", [
      ["service", serviceStatus.ok ? serviceStatus.output : "unknown"],
      ["worker service", workerServiceStatus.ok ? workerServiceStatus.output : "unknown"],
      ["uptime", formatting.duration(process.uptime())],
      ["memory rss", formatting.bytes(memory.rss)],
      ["memory heap", `${formatting.bytes(memory.heapUsed)} / ${formatting.bytes(memory.heapTotal)}`],
      ["active turns", activeTurns.size],
      ["side turns", queue.countSideTurns()],
      ["cached threads", threadCache.size],
      ["saved chats", Object.keys(state.chats).length],
      [
        "live progress",
        settings.runtimeValue("telegramLiveProgressEnabled")
          ? `${settings.runtimeValue("telegramLiveProgressMode")}, ${config.telegramLiveProgressSource}, ${config.telegramLiveProgressDeletePolicy}, ${Math.round(settings.runtimeValue("telegramLiveProgressIntervalMs") / 1000)}s interval`
          : "off"
      ],
      [
        "queue expiry",
        settings.runtimeValue("telegramPendingTurnMaxAgeSeconds") <= 0
          ? "off"
          : formatting.duration(settings.runtimeValue("telegramPendingTurnMaxAgeSeconds"))
      ],
      ["state read/write", stateCheck],
      ["backup dir write", backupCheck],
      ["workdir disk", workdirDisk],
      ["state disk", stateDisk],
      [
        "uploads",
        uploadPlan
          ? `${formatting.count(uploadPlan.candidates.length + uploadPlan.preserved.length)} / ${formatting.bytes(uploadPlan.totalBytes)}; cleanup ${formatting.count(uploadPlan.candidates.length)} / ${formatting.bytes(uploadPlan.candidateBytes)}`
          : "unavailable"
      ],
      ["pending turns", queue.countPendingTurns()],
      ["backup dir", config.backupDir],
      ["time zone", localization.timeZone()],
      ["locale", localization.locale()],
      [
        "snapshots",
        settings.runtimeValue("snapshotEnabled")
          ? `on, ${settings.runtimeValue("snapshotNotifyTime")} ${localization.timeZone()}, ${settings.runtimeValue("snapshotRetentionDays")}d retention`
          : "off"
      ]
    ]);
  }

  async function readModelsCacheMeta() {
    const config = settings.config;
    try {
      const stat = await fs.stat(config.codexModelsCacheFile);
      const parsed = JSON.parse(await fs.readFile(config.codexModelsCacheFile, "utf8"));
      const catalog = Array.isArray(parsed?.models) ? parsed.models : [];
      const fastModels = (await models.list())
        .filter((model) => model.fastSupported)
        .map((model) => model.slug);
      return {
        status: `found, ${catalog.length} models, ${formatting.bytes(stat.size)}`,
        clientVersion: parsed?.client_version || "unknown",
        fetchedAt: parsed?.fetched_at || "unknown",
        fastModels: fastModels.length > 0 ? fastModels.join(", ") : "unknown"
      };
    } catch (error) {
      return {
        status: `missing or unreadable: ${error instanceof Error ? error.message : String(error)}`,
        clientVersion: "unknown",
        fetchedAt: "unknown",
        fastModels: "unknown"
      };
    }
  }

  async function readYoloWrapperStatus() {
    try {
      const body = await fs.readFile(settings.config.codexPath, "utf8");
      return body.includes("--dangerously-bypass-approvals-and-sandbox")
        ? "enabled"
        : "not detected";
    } catch {
      return "not inspected";
    }
  }

  async function checkStateReadWrite() {
    try {
      await fs.readFile(settings.config.stateFile, "utf8");
      await checkDirectoryWritable(path.dirname(settings.config.stateFile));
      return "ok";
    } catch (error) {
      return `failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  async function getDiskSummary(targetPath) {
    const result = await readCommandOutput("df", ["-Pk", targetPath], 3000);
    if (!result.ok) return `unknown: ${result.error}`;
    const line = result.output.split("\n").at(-1);
    const parts = line?.trim().split(/\s+/) ?? [];
    if (parts.length < 6) return "unknown";
    const available = Number(parts[3]) * 1024;
    return `${formatting.bytes(available)} free, ${parts[4]} used`;
  }

  return {
    buildStatusDetails,
    formatDoctorHtml,
    formatHealthHtml,
    formatPendingDeliveryLines,
    formatQueueHtml,
    formatQueueModeHtml,
    formatRecoveryStatusHtml,
    formatRestartRecoveredHtml,
    formatRestartScheduledHtml,
    formatStatusHtml
  };
}

export async function readJsonFile(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

export async function readPackageJson(appRoot, packageName) {
  return readJsonFile(path.join(
    appRoot,
    "node_modules",
    ...packageName.split("/"),
    "package.json"
  ));
}

export async function readCommandOutput(command, args, timeoutMs) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      maxBuffer: 1024 * 1024,
      timeout: timeoutMs
    });
    return { ok: true, output: (stdout || stderr).trim() || "no output" };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function checkDirectoryWritable(dir) {
  const testFile = path.join(dir, `.write-test-${process.pid}-${Date.now()}`);
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(testFile, "ok\n", "utf8");
    await fs.rm(testFile, { force: true });
    return "ok";
  } catch (error) {
    await fs.rm(testFile, { force: true }).catch(() => {});
    return `failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}
