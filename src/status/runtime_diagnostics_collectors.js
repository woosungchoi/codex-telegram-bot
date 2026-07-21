import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import {
  readActiveTurnSnapshots,
  readRecoveryDedupe,
  readRestartMarker
} from "../recovery/state.js";
import { summarizeWorkerDeliveryStatus } from "../worker/delivery.js";

const execFileAsync = promisify(execFile);

export function createRuntimeDiagnosticsCollectors({
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
  packages
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

  async function collectRecoveryStatusRows() {
    const config = settings.config;
    const [active, marker, dedupe] = await Promise.all([
      readActiveTurnSnapshots(config.botRecoveryDir),
      readRestartMarker(config.botRecoveryDir),
      readRecoveryDedupe(config.botRecoveryDir)
    ]);
    const activeSnapshots = Object.values(active.turns ?? {});
    const dedupeEntries = Object.entries(dedupe.recentRecoveryKeys ?? {});
    return [
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
    ];
  }

  async function collectDoctorRows(chatKey) {
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
    return [
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
    ];
  }

  async function collectHealthRows() {
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
    return [
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
    ];
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
    collectDoctorRows,
    collectHealthRows,
    collectRecoveryStatusRows
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
