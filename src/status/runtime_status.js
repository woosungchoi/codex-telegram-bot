import { open as openFile } from "node:fs/promises";
import process from "node:process";
import { resolveAutoCompactTokenLimit } from "../codex/compact.js";
import { formatCodexUsageSummary } from "../status_usage.js";

const SESSION_TAIL_CHUNK_BYTES = 64 * 1024;
const MAX_SESSION_RECORD_BYTES = 1024 * 1024;

function parseTokenCountRecord(record) {
  if (record.length === 0) return null;
  try {
    const parsed = JSON.parse(record.toString("utf8"));
    if (parsed?.payload?.type !== "token_count") return null;
    return {
      tokenCount: parsed.payload,
      sampledAt: parsed.timestamp || parsed.time || parsed.created_at || ""
    };
  } catch {
    return null;
  }
}

async function readChunk(fileHandle, position, length) {
  const buffer = Buffer.allocUnsafe(length);
  let bytesRead = 0;
  while (bytesRead < length) {
    const result = await fileHandle.read(
      buffer,
      bytesRead,
      length - bytesRead,
      position + bytesRead
    );
    if (!result.bytesRead) break;
    bytesRead += result.bytesRead;
  }
  return buffer.subarray(0, bytesRead);
}

async function readLatestTokenCountFromTail(file, openSessionFile) {
  const fileHandle = await openSessionFile(file, "r");
  try {
    const { size } = await fileHandle.stat();
    let position = Number(size);
    let suffix = Buffer.alloc(0);
    let skippingOversizedRecord = false;

    while (position > 0) {
      const length = Math.min(SESSION_TAIL_CHUNK_BYTES, position);
      position -= length;
      const chunk = await readChunk(fileHandle, position, length);
      if (chunk.length === 0) break;

      const combined = suffix.length > 0 ? Buffer.concat([chunk, suffix]) : chunk;
      let recordEnd = combined.length;
      for (let index = combined.length - 1; index >= 0; index -= 1) {
        if (combined[index] !== 0x0a) continue;
        if (!skippingOversizedRecord) {
          const sample = parseTokenCountRecord(combined.subarray(index + 1, recordEnd));
          if (sample) return sample;
        }
        skippingOversizedRecord = false;
        recordEnd = index;
      }

      suffix = Buffer.from(combined.subarray(0, recordEnd));
      if (suffix.length > MAX_SESSION_RECORD_BYTES) {
        suffix = Buffer.alloc(0);
        skippingOversizedRecord = true;
      }
    }

    return skippingOversizedRecord ? null : parseTokenCountRecord(suffix);
  } finally {
    await fileHandle.close();
  }
}

export function createRuntimeStatusSupport({
  settings,
  chats,
  packages,
  sessions,
  localization,
  formatting,
  openSessionFile = openFile,
  now = () => new Date()
}) {
  async function buildAppSummary() {
    const botPackage = await packages.readJson(settings.packageFile);
    const sdkPackage = await packages.readPackage("@openai/codex-sdk");
    const currentTime = now();
    return {
      botVersion: botPackage?.version || "",
      node: process.version,
      codexSdk: sdkPackage?.version || "",
      startedAt: new Date(currentTime.getTime() - process.uptime() * 1000).toISOString()
    };
  }

  function buildConfigSummary() {
    const config = settings.config;
    return formatting.redactValue({
      codexWorkdir: config.codexWorkdir,
      codexPath: config.codexPath,
      codexModel: config.codexModel,
      codexApprovalPolicy: config.codexApprovalPolicy,
      codexSandboxMode: config.codexSandboxMode,
      codexReasoningEffort: config.codexReasoningEffort,
      codexWebSearch: config.codexWebSearch,
      codexNetworkAccess: config.codexNetworkAccess,
      codexWebSearchEnabled: config.codexWebSearchEnabled,
      codexSkipGitRepoCheck: config.codexSkipGitRepoCheck,
      codexAdditionalDirectories: config.codexAdditionalDirectories,
      telegramLiveProgressEnabled: settings.runtimeValue("telegramLiveProgressEnabled"),
      telegramLiveProgressIntervalSeconds: Math.round(
        settings.runtimeValue("telegramLiveProgressIntervalMs") / 1000
      ),
      telegramLiveProgressMode: settings.runtimeValue("telegramLiveProgressMode"),
      telegramLiveProgressSource: config.telegramLiveProgressSource,
      telegramLiveProgressDeletePolicy: config.telegramLiveProgressDeletePolicy,
      telegramPendingTurnsMax: settings.runtimeValue("telegramPendingTurnsMax"),
      telegramPendingTurnMaxAgeSeconds: settings.runtimeValue("telegramPendingTurnMaxAgeSeconds"),
      botRestartRecoveryEnabled: config.botRestartRecoveryEnabled,
      botRestartExitCode: config.botRestartExitCode,
      botRestartDrainTimeoutSeconds: config.botRestartDrainTimeoutSeconds,
      botRestartDelaySeconds: config.botRestartDelaySeconds,
      botRecoveryDir: config.botRecoveryDir,
      botRecoveryStaleSeconds: config.botRecoveryStaleSeconds,
      botRecoveryTurnTtlSeconds: config.botRecoveryTurnTtlSeconds,
      botRecoverySuspendAfter: config.botRecoverySuspendAfter,
      botRecoveryBackfillPollMs: config.botRecoveryBackfillPollMs,
      telegramLanguage: config.telegramLanguage,
      telegramTimeZone: config.telegramTimeZone,
      telegramLocale: config.telegramLocale,
      codexBaseUrl: config.codexBaseUrl,
      codexApiKey: config.codexApiKey ? "set" : "",
      codexConfig: config.codexConfig ? "set" : "",
      codexEnv: config.codexEnv ? "set" : "",
      codexAutoCompactTokenLimit: resolveAutoCompactTokenLimit(config) || "default",
      codexToolOutputTokenLimit: config.codexToolOutputTokenLimit || "default",
      codexCompactStrength: config.codexCompactStrength,
      codexContextGuardEnabled: config.codexContextGuardEnabled,
      codexContextCompactThresholdPercent: config.codexContextCompactThresholdPercent,
      codexContextMinRemainingTokens: config.codexContextMinRemainingTokens,
      stateFile: config.stateFile,
      codexSessionsDir: config.codexSessionsDir,
      uploadDir: config.uploadDir,
      backupDir: config.backupDir,
      cleanupQuarantineDir: config.cleanupQuarantineDir,
      cleanupEnabled: settings.runtimeValue("cleanupEnabled"),
      cleanupExecutionMode: settings.runtimeValue("cleanupExecutionMode"),
      cleanupNotifyTime: settings.runtimeValue("cleanupNotifyTime"),
      cleanupRetentionDays: settings.runtimeValue("cleanupRetentionDays"),
      cleanupQuarantineDays: settings.runtimeValue("cleanupQuarantineDays"),
      cleanupPlanTtlHours: settings.runtimeValue("cleanupPlanTtlHours"),
      snapshotEnabled: settings.runtimeValue("snapshotEnabled"),
      snapshotNotifyTime: settings.runtimeValue("snapshotNotifyTime"),
      snapshotRetentionDays: settings.runtimeValue("snapshotRetentionDays")
    });
  }

  function getLocalClock() {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: localization.timeZone(),
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23"
      }).formatToParts(now()).map((part) => [part.type, part.value])
    );
    return {
      dateKey: `${parts.year}-${parts.month}-${parts.day}`,
      time: `${parts.hour}:${parts.minute}`
    };
  }

  function getLocalDateKey() {
    return getLocalClock().dateKey;
  }

  function formatDateTime(value) {
    return new Intl.DateTimeFormat(localization.locale(), {
      timeZone: localization.timeZone(),
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZoneName: "short"
    }).format(new Date(value)).replace(",", "");
  }

  function formatBytes(bytes) {
    if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 102.4) / 10} MB`;
    if (bytes >= 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
    return `${bytes} B`;
  }

  async function readLatestTokenCount(threadId) {
    const file = await sessions.findFile(threadId);
    if (!file) return null;
    return readLatestTokenCountFromTail(file, openSessionFile);
  }

  async function buildBestCodexUsageSummary(chatKey, threadId) {
    const chat = chats.get(chatKey);
    const latest = await selectLatestUsageSample([
      { threadId, sourceLabel: "current thread" },
      { threadId: chat.usageProbeThreadId || "", sourceLabel: "usage probe" }
    ]);
    return formatCodexUsageSummary({
      tokenCount: latest?.tokenCount,
      sampledAt: latest?.sampledAt,
      sourceLabel: latest?.sourceLabel,
      now: now(),
      locale: localization.locale(),
      timeZone: localization.timeZone()
    });
  }

  async function selectLatestUsageSample(candidates) {
    let latest = null;
    const seen = new Set();
    for (const candidate of candidates) {
      if (!candidate.threadId || seen.has(candidate.threadId)) continue;
      seen.add(candidate.threadId);
      const sample = await readLatestTokenCount(candidate.threadId);
      if (!sample) continue;
      const sampledAt = Date.parse(sample.sampledAt);
      const latestSampledAt = latest ? Date.parse(latest.sampledAt) : Number.NEGATIVE_INFINITY;
      if (!latest || sampledAt >= latestSampledAt) {
        latest = { ...sample, sourceLabel: candidate.sourceLabel };
      }
    }
    return latest;
  }

  return {
    buildAppSummary,
    buildBestCodexUsageSummary,
    buildConfigSummary,
    formatBytes,
    formatDateTime,
    getLocalClock,
    getLocalDateKey,
    readLatestTokenCount
  };
}
