import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { appendPrivateFile } from "../fs/private.js";
import { b, code } from "../telegram/html.js";

const execFileAsync = promisify(execFile);

export function createCleanupRuntime({
  settings,
  state,
  activeTurns,
  threadCache,
  sessions,
  cleanup,
  maintenance,
  telegram,
  localization,
  formatting,
  persistence,
  uploads,
  timers = { setTimeout, setInterval },
  runProcess = execFileAsync,
  now = () => new Date()
}) {
  async function editCleanupMessage(ctx, html) {
    return telegram.editOrReplyHtml(ctx, html, emptyKeyboard());
  }

  async function editUploadCleanupMessage(ctx, html) {
    return telegram.editOrReplyHtml(ctx, html, emptyKeyboard());
  }

  async function editCleanupProcessingMessage(ctx, action, plan) {
    return telegram.editOrReplyHtml(ctx, formatCleanupProcessingHtml(action, plan), {
      reply_markup: {
        inline_keyboard: [[{
          text: localization.text("cleanupProcessingButton"),
          callback_data: `cleanup:processing:${plan.id}`
        }]]
      }
    });
  }

  function cleanupActionLabel(action) {
    if (action === "quarantine") return localization.text("cleanupActionQuarantine");
    if (action === "delete") return localization.text("cleanupActionDelete");
    if (action === "both") return localization.text("cleanupActionBoth");
    if (action === "ignore") return localization.text("cleanupActionIgnore");
    return action;
  }

  function cleanupCallbackText(action) {
    if (action === "quarantine") return localization.text("cleanupCallbackQuarantine");
    if (action === "delete") return localization.text("cleanupCallbackDelete");
    if (action === "both") return localization.text("cleanupCallbackBoth");
    if (action === "ignore") return localization.text("cleanupCallbackIgnore");
    if (action === "missing") return localization.text("cleanupCallbackMissing");
    if (action === "expired") return localization.text("cleanupCallbackExpired");
    return "";
  }

  async function answerCleanupCallback(ctx, action) {
    try {
      await ctx.answerCbQuery(cleanupCallbackText(action));
    } catch (error) {
      console.warn("cleanup callback answer failed:", telegram.summarizeError(error));
    }
  }

  async function answerUploadCleanupCallback(ctx, status) {
    const text = status === "confirm"
      ? "Deleting selected upload cleanup candidates..."
      : status === "expired_plan"
        ? "Upload cleanup plan expired."
        : status === "processing"
          ? "Upload cleanup is already processing."
          : "Upload cleanup plan not found.";
    try {
      await ctx.answerCbQuery(text);
    } catch (error) {
      console.warn("upload cleanup callback answer failed:", telegram.summarizeError(error));
    }
  }

  function formatCleanupProcessingHtml(action, plan) {
    return [
      b(localization.formatText("cleanupProcessingTitle", {
        action: cleanupActionLabel(action)
      })),
      "",
      localization.text("cleanupProcessingBody"),
      "",
      b(localization.text("cleanupTargets")),
      `- ${localization.text("cleanupQuarantineCandidates")}: ${code(formatting.count(plan.quarantineCandidates.length))}`,
      `- ${localization.text("cleanupPermanentDeleteCandidates")}: ${code(formatting.count(plan.deleteCandidates.length))}`,
      "",
      localization.text("cleanupFinishReplace")
    ].join("\n");
  }

  function formatCleanupIgnoredHtml(plan) {
    return [
      b(localization.text("cleanupIgnoredTitle")),
      "",
      `${localization.text("cleanupQuarantineCandidates")}: ${code(formatting.count(plan.quarantineCandidates.length))}`,
      `${localization.text("cleanupPermanentDeleteCandidates")}: ${code(formatting.count(plan.deleteCandidates.length))}`,
      "",
      localization.text("cleanupNoFilesMoved")
    ].join("\n");
  }

  function formatCleanupResultHtml(action, result, plan = null) {
    const lines = [
      b(localization.formatText("cleanupResultTitle", { action: cleanupActionLabel(action) })),
      "",
      `${localization.text("cleanupResultQuarantined")}: ${code(result.quarantined)}`,
      `${localization.text("cleanupResultDeleted")}: ${code(result.deleted)}`,
      `${localization.text("cleanupResultSkipped")}: ${code(result.skipped)}`,
      `${localization.text("cleanupResultErrors")}: ${code(result.errors.length)}`,
      `manifest: ${code(result.manifest || "none")}`,
      `restore: ${code(result.restoreScript || "none")}`
    ];
    if (plan) {
      lines.push(
        "",
        b(localization.text("cleanupTargetSummary")),
        `- ${localization.text("cleanupQuarantineCandidates")}: ${code(formatting.count(plan.quarantineCandidates.length))}`,
        `- ${localization.text("cleanupPermanentDeleteCandidates")}: ${code(formatting.count(plan.deleteCandidates.length))}`
      );
    }
    if (result.errors.length > 0) {
      lines.push("", ...result.errors.slice(0, 3).map((error) => `- ${code(error)}`));
    }
    return lines.join("\n");
  }

  async function listCleanupSessionFiles(protectedThreadIds) {
    let files = [];
    try {
      files = await sessions.listFiles(settings.config.codexSessionsDir);
    } catch (error) {
      if (error?.code === "ENOENT") {
        return { protectedCount: protectedThreadIds.size, recentCount: 0, candidates: [] };
      }
      throw error;
    }

    const currentTime = now().getTime();
    const cutoff = currentTime
      - settings.runtimeValue("cleanupRetentionDays") * 24 * 60 * 60 * 1000;
    const candidates = [];
    let recentCount = 0;
    for (const file of files.filter((entry) => entry.endsWith(".jsonl"))) {
      const meta = await sessions.readMeta(file);
      if (!meta?.id) continue;
      const stat = await fs.stat(file);
      if (protectedThreadIds.has(meta.id)) continue;
      if (stat.mtimeMs >= cutoff) {
        recentCount += 1;
        continue;
      }
      candidates.push({
        threadId: meta.id,
        path: file,
        modifiedAt: stat.mtime.toISOString(),
        ageDays: Math.floor((currentTime - stat.mtimeMs) / 86_400_000),
        bytes: stat.size
      });
    }
    candidates.sort((left, right) => left.modifiedAt.localeCompare(right.modifiedAt));
    return { protectedCount: protectedThreadIds.size, recentCount, candidates };
  }

  async function listQuarantineDeleteCandidates() {
    let files = [];
    try {
      files = await sessions.listFiles(settings.config.cleanupQuarantineDir);
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    const currentTime = now().getTime();
    const cutoff = currentTime
      - settings.runtimeValue("cleanupQuarantineDays") * 24 * 60 * 60 * 1000;
    const candidates = [];
    for (const file of files.filter((entry) => entry.endsWith(".jsonl"))) {
      const stat = await fs.stat(file);
      const metadata = await readCleanupMetadata(file);
      const quarantinedAt = metadata?.quarantinedAt
        ? Date.parse(metadata.quarantinedAt)
        : stat.mtimeMs;
      if (Number.isNaN(quarantinedAt) || quarantinedAt >= cutoff) continue;
      const meta = await sessions.readMeta(file);
      candidates.push({
        threadId: metadata?.threadId || meta?.id || path.basename(file, ".jsonl"),
        path: file,
        originalPath: metadata?.originalPath || "",
        quarantinedAt: new Date(quarantinedAt).toISOString(),
        quarantineAgeDays: Math.floor((currentTime - quarantinedAt) / 86_400_000),
        bytes: stat.size
      });
    }
    candidates.sort((left, right) => left.quarantinedAt.localeCompare(right.quarantinedAt));
    return candidates;
  }

  async function readCleanupMetadata(file) {
    try {
      return JSON.parse(await fs.readFile(`${file}.cleanup.json`, "utf8"));
    } catch {
      return null;
    }
  }

  async function collectProtectedThreadIds() {
    const protectedThreadIds = new Set();
    for (const chat of Object.values(state.chats)) {
      if (chat?.threadId) protectedThreadIds.add(chat.threadId);
    }
    for (const thread of threadCache.values()) {
      if (thread?.id) protectedThreadIds.add(thread.id);
    }
    for (const threadId of await listRunningCodexThreadIds()) {
      protectedThreadIds.add(threadId);
    }
    return protectedThreadIds;
  }

  async function listRunningCodexThreadIds() {
    try {
      const { stdout } = await runProcess("ps", ["-eo", "args="], {
        maxBuffer: 2 * 1024 * 1024
      });
      const ids = new Set();
      const pattern = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
      for (const line of stdout.split("\n")) {
        if (!line.toLowerCase().includes("codex")) continue;
        for (const match of line.matchAll(pattern)) ids.add(match[0]);
      }
      return [...ids];
    } catch {
      return [];
    }
  }

  function startCleanupScheduler() {
    timers.setTimeout(runScheduledCleanup, 5000);
    timers.setInterval(runScheduledCleanup, 60_000);
  }

  function runScheduledCleanup() {
    runDailyCleanupCheck().catch((error) => {
      console.error("cleanup scheduler failed", error);
    });
  }

  async function runDailyCleanupCheck() {
    if (!settings.runtimeValue("cleanupEnabled")) return;
    const clock = formatting.localClock();
    if (state.cleanup.lastDailyDate === clock.dateKey) return;
    if (clock.time < settings.runtimeValue("cleanupNotifyTime")) return;

    await cleanup.sendDailyPlan();
    await runAutomaticCodexMaintenanceIfEnabled();
    await runDailyUploadCleanupIfEnabled();
    state.cleanup.lastDailyDate = clock.dateKey;
    pruneExpiredCleanupPlans();
    pruneExpiredUploadCleanupPlans();
    await persistence.save();
  }

  async function runDailyUploadCleanupIfEnabled() {
    if (!uploads.shouldRun({
      cleanupEnabled: settings.runtimeValue("cleanupEnabled"),
      uploadCleanupEnabled: settings.config.uploadCleanupEnabled
    })) return;
    const plan = await createUploadCleanupPlan({ dryRun: true });
    await appendCleanupLog(uploads.createPlanLogEntry(plan));
  }

  async function runAutomaticCodexMaintenanceIfEnabled() {
    if (maintenance.autoHandoffEnabled()) {
      const results = [];
      const seen = new Set();
      for (const chat of Object.values(state.chats)) {
        const threadId = chat?.threadId;
        if (!threadId || seen.has(threadId)) continue;
        seen.add(threadId);
        try {
          results.push(await maintenance.createThreadHandoff(threadId));
        } catch (error) {
          results.push({
            ok: false,
            threadId,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
      await appendCleanupLog({
        type: "auto_handoff",
        count: results.length,
        results,
        at: now().toISOString()
      });
    }

    if (!maintenance.autoSqliteRepairEnabled()) return;
    if (activeTurns.size > 0) {
      await appendCleanupLog({
        type: "auto_sqlite_repair_skipped",
        reason: "active_turns",
        count: activeTurns.size,
        at: now().toISOString()
      });
      return;
    }
    try {
      const result = await maintenance.run("sqlite-metadata-repair");
      await appendCleanupLog({ type: "auto_sqlite_repair", result, at: now().toISOString() });
    } catch (error) {
      await appendCleanupLog({
        type: "auto_sqlite_repair_error",
        message: error instanceof Error ? error.message : String(error),
        at: now().toISOString()
      });
    }
  }

  function pruneExpiredCleanupPlans() {
    const currentTime = now().getTime();
    for (const [planId, plan] of Object.entries(state.cleanup.plans)) {
      if (!plan?.expiresAt || Date.parse(plan.expiresAt) < currentTime) {
        delete state.cleanup.plans[planId];
      }
    }
  }

  function pruneExpiredUploadCleanupPlans() {
    const currentTime = now().getTime();
    for (const [planId, record] of Object.entries(state.uploadCleanup.plans)) {
      if (!record?.expiresAt || Date.parse(record.expiresAt) < currentTime) {
        delete state.uploadCleanup.plans[planId];
      }
    }
  }

  async function appendCleanupLog(entry) {
    await appendPrivateFile(settings.config.cleanupLogFile, `${JSON.stringify(entry)}\n`, "utf8");
  }

  async function createUploadCleanupPlan(options = {}) {
    return uploads.buildPlan(settings.config.uploadDir, {
      retentionDays: settings.config.uploadRetentionDays,
      maxBytes: settings.config.uploadMaxBytes,
      dryRun: options.dryRun !== false
    });
  }

  return {
    answerCleanupCallback,
    answerUploadCleanupCallback,
    appendCleanupLog,
    collectProtectedThreadIds,
    createUploadCleanupPlan,
    editCleanupMessage,
    editCleanupProcessingMessage,
    editUploadCleanupMessage,
    formatCleanupIgnoredHtml,
    formatCleanupResultHtml,
    listCleanupSessionFiles,
    listQuarantineDeleteCandidates,
    pruneExpiredCleanupPlans,
    pruneExpiredUploadCleanupPlans,
    runDailyCleanupCheck,
    startCleanupScheduler
  };
}

function emptyKeyboard() {
  return { reply_markup: { inline_keyboard: [] } };
}
