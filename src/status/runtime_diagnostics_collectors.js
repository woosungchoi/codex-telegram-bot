import { createMessageFormatter } from "../i18n.js";
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
  const msg = createMessageFormatter(localization.text);
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
      [msg("ui.enabled"), config.botRestartRecoveryEnabled ? msg("ui.yes") : msg("ui.no")],
      [msg("ui.activeSnapshots"), activeSnapshots.length],
      [msg("ui.restartMarker"), marker?.restartId || msg("ui.none")],
      [msg("ui.markerMode"), marker?.mode || msg("ui.none")],
      [msg("ui.markerRecoveries"), marker?.recoveries?.length ?? 0],
      [msg("ui.staleSeconds"), config.botRecoveryStaleSeconds],
      [msg("ui.suspendAfter"), config.botRecoverySuspendAfter],
      [
        msg("ui.backfillPoll"),
        config.botRecoveryBackfillPollMs > 0 ? `${config.botRecoveryBackfillPollMs}ms` : msg("ui.off")
      ],
      [msg("ui.recentRecoveryKeys"), dedupeEntries.length],
      [msg("ui.lastActive"), activeSnapshots.at(-1)?.chatKey || msg("ui.none")]
    ];
  }

  async function collectDoctorRows(chatKey) {
    const config = settings.config;
    const [botPackage, sdkPackage, cliVersion, modelsMeta, yoloWrapper] = await Promise.all([
      packages.readJson(settings.packageFile),
      packages.readPackage("@openai/codex-sdk"),
      readCommandOutput(config.codexPath, ["--version"], 5000, msg),
      readModelsCacheMeta(),
      readYoloWrapperStatus()
    ]);
    const effective = options.get(chatKey);
    const declaredSdk = botPackage?.dependencies?.["@openai/codex-sdk"] || msg("ui.unknown");
    return [
      [msg("ui.botVersion"), botPackage?.version || msg("ui.unknown")],
      [msg("ui.node"), process.version],
      [msg("ui.codexSdkInstalled"), sdkPackage?.version || msg("ui.unknown")],
      [msg("ui.codexSdkDeclared"), declaredSdk],
      [msg("ui.codexCli"), cliVersion.ok ? cliVersion.output : msg("ui.errorLine", { value1: cliVersion.error })],
      [msg("ui.codexPath"), config.codexPath],
      [msg("ui.yoloWrapper"), yoloWrapper],
      [msg("ui.modelsCache"), modelsMeta.status],
      [msg("ui.modelsCacheClient"), modelsMeta.clientVersion],
      [msg("ui.modelsCacheFetched"), modelsMeta.fetchedAt],
      [msg("ui.fastModels"), modelsMeta.fastModels],
      [msg("ui.currentModel"), effective.model || msg("ui.default")],
      [msg("ui.currentThinking"), effective.modelReasoningEffort],
      [msg("ui.currentServiceTier"), effective.serviceTier || msg("ui.default")],
      [msg("ui.workerMode"), settings.runtimeValue("codexWorkerMode")],
      [msg("ui.workerSocket"), config.codexWorkerSocket],
      [msg("ui.codexTransport"), settings.runtimeValue("codexTransport")],
      [msg("ui.appServerDirectTimeout"), `${settings.runtimeValue("codexAppServerDirectTimeoutMs")}ms`],
      [
        msg("ui.recoveryBackfillPoll"),
        config.botRecoveryBackfillPollMs > 0 ? `${config.botRecoveryBackfillPollMs}ms` : msg("ui.off")
      ],
      [msg("ui.upgradeSmokeTest"), "/status -> /model -> /fast_status -> message -> /new -> /resume_last"]
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
      checkDirectoryWritable(config.backupDir, msg),
      getDiskSummary(config.codexWorkdir),
      getDiskSummary(path.dirname(config.stateFile)),
      readCommandOutput("systemctl", ["--user", "is-active", "codex-telegram-bot.service"], 3000, msg),
      readCommandOutput("systemctl", ["--user", "is-active", "codex-telegram-worker.service"], 3000, msg),
      uploads.createCleanupPlan({ dryRun: true }).catch(() => null)
    ]);
    return [
      [msg("ui.service"), serviceStatus.ok ? serviceStatus.output : msg("ui.unknown")],
      [msg("ui.workerService"), workerServiceStatus.ok ? workerServiceStatus.output : msg("ui.unknown")],
      [msg("ui.uptime"), formatting.duration(process.uptime())],
      [msg("ui.memoryRss"), formatting.bytes(memory.rss)],
      [msg("ui.memoryHeap"), `${formatting.bytes(memory.heapUsed)} / ${formatting.bytes(memory.heapTotal)}`],
      [msg("ui.activeTurns"), activeTurns.size],
      [msg("ui.sideTurns"), queue.countSideTurns()],
      [msg("ui.cachedThreads"), threadCache.size],
      [msg("ui.savedChats"), Object.keys(state.chats).length],
      [
        msg("ui.liveProgress2"),
        settings.runtimeValue("telegramLiveProgressEnabled")
          ? msg("ui.sIntervalLine", { value1: settings.runtimeValue("telegramLiveProgressMode"), value2: config.telegramLiveProgressSource, value3: config.telegramLiveProgressDeletePolicy, value4: Math.round(settings.runtimeValue("telegramLiveProgressIntervalMs") / 1000) })
          : msg("ui.off")
      ],
      [
        msg("ui.queueExpiry"),
        settings.runtimeValue("telegramPendingTurnMaxAgeSeconds") <= 0
          ? msg("ui.off")
          : formatting.duration(settings.runtimeValue("telegramPendingTurnMaxAgeSeconds"))
      ],
      [msg("ui.stateReadWrite"), stateCheck],
      [msg("ui.backupDirWrite"), backupCheck],
      [msg("ui.workdirDisk"), workdirDisk],
      [msg("ui.stateDisk"), stateDisk],
      [
        msg("ui.uploads"),
        uploadPlan
          ? msg("ui.cleanupLine", { value1: formatting.count(uploadPlan.candidates.length + uploadPlan.preserved.length), value2: formatting.bytes(uploadPlan.totalBytes), value3: formatting.count(uploadPlan.candidates.length), value4: formatting.bytes(uploadPlan.candidateBytes) })
          : msg("ui.unavailable")
      ],
      [msg("ui.pendingTurns"), queue.countPendingTurns()],
      [msg("ui.backupDir"), config.backupDir],
      [msg("ui.timeZone2"), localization.timeZone()],
      [msg("ui.locale"), localization.locale()],
      [
        msg("ui.snapshots"),
        settings.runtimeValue("snapshotEnabled")
          ? msg("ui.onDRetentionLine", { value1: settings.runtimeValue("snapshotNotifyTime"), value2: localization.timeZone(), value3: settings.runtimeValue("snapshotRetentionDays") })
          : msg("ui.off")
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
        status: msg("ui.cacheFound", { count: catalog.length, size: formatting.bytes(stat.size) }),
        clientVersion: parsed?.client_version || msg("ui.unknown"),
        fetchedAt: parsed?.fetched_at || msg("ui.unknown"),
        fastModels: fastModels.length > 0 ? fastModels.join(", ") : msg("ui.unknown")
      };
    } catch (error) {
      return {
        status: msg("ui.cacheUnreadable", { error: error instanceof Error ? error.message : String(error) }),
        clientVersion: msg("ui.unknown"),
        fetchedAt: msg("ui.unknown"),
        fastModels: msg("ui.unknown")
      };
    }
  }

  async function readYoloWrapperStatus() {
    try {
      const body = await fs.readFile(settings.config.codexPath, "utf8");
      return body.includes("--dangerously-bypass-approvals-and-sandbox")
        ? msg("ui.enabled")
        : msg("ui.not_detected");
    } catch {
      return msg("ui.not_inspected");
    }
  }

  async function checkStateReadWrite() {
    try {
      await fs.readFile(settings.config.stateFile, "utf8");
      await checkDirectoryWritable(path.dirname(settings.config.stateFile), msg);
      return msg("ui.Ok");
    } catch (error) {
      return msg("ui.checkFailed", { error: error instanceof Error ? error.message : String(error) });
    }
  }

  async function getDiskSummary(targetPath) {
    const result = await readCommandOutput("df", ["-Pk", targetPath], 3000);
    if (!result.ok) return msg("ui.checkUnknown", { error: result.error });
    const line = result.output.split("\n").at(-1);
    const parts = line?.trim().split(/\s+/) ?? [];
    if (parts.length < 6) return msg("ui.unknown");
    const available = Number(parts[3]) * 1024;
    return msg("ui.diskSpace", { available: formatting.bytes(available), used: parts[4] });
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

export async function readCommandOutput(command, args, timeoutMs, text) {
  const msg = createMessageFormatter(text);
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      maxBuffer: 1024 * 1024,
      timeout: timeoutMs
    });
    return { ok: true, output: (stdout || stderr).trim() || msg("ui.noOutput") };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function checkDirectoryWritable(dir, msg = createMessageFormatter()) {
  const testFile = path.join(dir, `.write-test-${process.pid}-${Date.now()}`);
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(testFile, "ok\n", "utf8");
    await fs.rm(testFile, { force: true });
    return msg("ui.Ok");
  } catch (error) {
    await fs.rm(testFile, { force: true }).catch(() => {});
    return msg("ui.checkFailed", { error: error instanceof Error ? error.message : String(error) });
  }
}
