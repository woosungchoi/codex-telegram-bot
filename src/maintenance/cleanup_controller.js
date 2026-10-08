import { anchoredMove, anchoredUnlink, fileIdentity } from "../fs/anchored.js";
import { createMessageFormatter } from "../i18n.js";
import fs from "node:fs/promises";
import path from "node:path";
import {
  createCleanupArtifact,
  finalizeCleanupArtifact
} from "./cleanup.js";
import { b, code } from "../telegram/html.js";
import { parseCleanupExecutionMode } from "./cleanup_mode.js";
import { createNavigationKeyboardViews } from "../ui/keyboard_helpers.js";

export function createCleanupController({
  stateStore,
  policy,
  inventory,
  telegram,
  formatting,
  now = () => new Date(),
  random = Math.random
}) {
  const {
    text: t,
    formatText: tf,
    formatBytes,
    formatDateTime,
    formatCount,
    formatResult
  } = formatting;
  const msg = createMessageFormatter(t);
  const navigation = createNavigationKeyboardViews({ text: t });

  async function createCleanupPlan(source) {
    stateStore.prunePlans();
    const sessionScan = await inventory.listSessionFiles(
      await inventory.collectProtectedThreadIds()
    );
    const deleteCandidates = await inventory.listDeleteCandidates();
    const maintenance = await inventory.readMaintenanceReport().catch((error) => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }));
    const createdAt = now();
    const plan = {
      id: `${createdAt.getTime().toString(36)}-${random().toString(36).slice(2, 8)}`,
      source,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(
        createdAt.getTime() + policy.planTtlHours() * 60 * 60 * 1000
      ).toISOString(),
      retentionDays: policy.retentionDays(),
      quarantineDays: policy.quarantineDays(),
      protectedCount: sessionScan.protectedCount,
      recentCount: sessionScan.recentCount,
      quarantineCandidates: sessionScan.candidates,
      deleteCandidates,
      maintenance
    };
    stateStore.plans[plan.id] = plan;
    await stateStore.appendLog({
      type: "plan",
      source,
      planId: plan.id,
      summary: summarizeCleanupPlan(plan),
      at: createdAt.toISOString()
    });
    return plan;
  }

  async function sendCleanupPlan(ctx, plan) {
    if (ctx.callbackQuery) return telegram.editOrReplyHtml(ctx, formatCleanupPlanHtml(plan), cleanupKeyboard(plan.id));
    await telegram.replyHtml(ctx, formatCleanupPlanHtml(plan), cleanupKeyboard(plan.id));
  }

  async function sendDailyCleanupPlan() {
    const plan = await createCleanupPlan("daily");
    await stateStore.save();
    if (plan.quarantineCandidates.length === 0 && plan.deleteCandidates.length === 0) {
      return;
    }

    for (const chatId of policy.notifyChatIds) {
      try {
        await telegram.sendHtmlMessage(
          chatId,
          formatCleanupPlanHtml(plan),
          cleanupKeyboard(plan.id)
        );
      } catch (error) {
        await stateStore.appendLog({
          type: "notify_error",
          chatId,
          message: error instanceof Error ? error.message : String(error),
          at: now().toISOString()
        });
      }
    }
  }

  async function runDailyCleanup(rawMode) {
    const mode = parseCleanupExecutionMode(rawMode, "cleanup execution mode");
    if (mode === "manual") {
      await sendDailyCleanupPlan();
      return { ok: true, mode, action: null };
    }

    let plan;
    let result = emptyCleanupResult();
    try {
      plan = await createCleanupPlan("daily-auto");
      await stateStore.save();
      const targetCount = mode === "quarantine"
        ? plan.quarantineCandidates.length
        : mode === "delete"
          ? plan.deleteCandidates.length
          : plan.quarantineCandidates.length + plan.deleteCandidates.length;
      result = targetCount > 0
        ? await applyCleanupPlan(plan, mode)
        : emptyCleanupResult();
      delete stateStore.plans[plan.id];
      await stateStore.appendLog({
        type: "apply",
        source: "daily-auto",
        automatic: true,
        action: mode,
        planId: plan.id,
        result,
        at: now().toISOString()
      });
      await stateStore.save();
      await sendDailyCleanupResult(mode, result, plan);
      return { ok: result.errors.length === 0, mode, action: mode, plan, result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result = { ...result, errors: [...result.errors, message] };
      await stateStore.appendLog({
        type: "apply_error",
        source: "daily-auto",
        automatic: true,
        action: mode,
        planId: plan?.id || null,
        message,
        at: now().toISOString()
      }).catch(() => {});
      await stateStore.save().catch(() => {});
      await sendDailyCleanupResult(mode, result, plan || emptyCleanupPlan());
      return { ok: false, mode, action: mode, plan, result };
    }
  }

  async function sendDailyCleanupResult(action, result, plan) {
    for (const chatId of policy.notifyChatIds) {
      try {
        await telegram.sendHtmlMessage(chatId, formatResult(action, result, plan));
      } catch (error) {
        await stateStore.appendLog({
          type: "notify_error",
          source: "daily-auto",
          chatId,
          message: error instanceof Error ? error.message : String(error),
          at: now().toISOString()
        }).catch(() => {});
      }
    }
  }

  function cleanupKeyboard(planId) {
    const plan = stateStore.plans[planId];
    const quarantineCount = plan?.quarantineCandidates?.length ?? 0;
    const deleteCount = plan?.deleteCandidates?.length ?? 0;
    return navigation.withMenuCloseButton(navigation.withPreviousPanelButton({
      reply_markup: {
        inline_keyboard: [
          [
            cleanupButton(
              `${t("cleanupButtonQuarantineOnly")} (${quarantineCount})`,
              `cleanup:quarantine:${planId}`,
              "primary"
            ),
            cleanupButton(
              `${t("cleanupButtonDeletePermanently")} (${deleteCount})`,
              `cleanup:delete:${planId}`,
              "danger"
            )
          ],
          [
            cleanupButton(t("cleanupButtonRunBoth"), `cleanup:both:${planId}`, "danger"),
            cleanupButton(t("cleanupButtonIgnore"), `cleanup:ignore:${planId}`, "primary")
          ]
        ]
      }
    }, "tools"));
  }

  function cleanupButton(text, callbackData, style) {
    return { text, callback_data: callbackData, style };
  }

  function formatCleanupPlanHtml(plan) {
    const quarantineBytes = sum(plan.quarantineCandidates.map((candidate) => candidate.bytes));
    const deleteBytes = sum(plan.deleteCandidates.map((candidate) => candidate.bytes));
    const lines = [
      b(t("cleanupPlanTitle")),
      "",
      `${t("cleanupToQuarantine")}: ${code(formatCount(plan.quarantineCandidates.length))} (${code(formatBytes(quarantineBytes))})`,
      `${t("cleanupToDeletePermanently")}: ${code(formatCount(plan.deleteCandidates.length))} (${code(formatBytes(deleteBytes))})`,
      "",
      b(t("cleanupProtected")),
      `- ${t("cleanupConnectedRunningThreads")}: ${code(formatCount(plan.protectedCount))}`,
      `- ${tf("cleanupRecentThreadsLogs", { days: plan.retentionDays })}: ${code(formatCount(plan.recentCount))}`,
      "",
      `${t("cleanupQuarantineRule")}: ${code(tf("cleanupOlderThanDays", { days: plan.retentionDays }))}`,
      `${t("cleanupDeleteRule")}: ${code(tf("cleanupDeleteAfterQuarantineDays", { days: plan.quarantineDays }))}`,
      `${t("cleanupApprovalExpires")}: ${code(formatDateTime(plan.expiresAt))}`
    ];
    lines.push(...formatCleanupMaintenanceSummaryLines(plan.maintenance));

    if (plan.quarantineCandidates.length > 0) {
      lines.push("", b(t("cleanupQuarantineSample")));
      for (const candidate of plan.quarantineCandidates.slice(0, 5)) {
        lines.push(
          `- ${code(candidate.threadId)} (${code(`${candidate.ageDays}d`)}, ${code(formatBytes(candidate.bytes))})`
        );
      }
    }

    if (plan.deleteCandidates.length > 0) {
      lines.push("", b(t("cleanupPermanentDeleteSample")));
      for (const candidate of plan.deleteCandidates.slice(0, 5)) {
        lines.push(
          `- ${code(candidate.threadId)} (${code(`${candidate.quarantineAgeDays}d quarantined`)}, ${code(formatBytes(candidate.bytes))})`
        );
      }
    }

    lines.push("", t("cleanupImportantHandoffWarning"));
    lines.push(t("cleanupNoFilesUntilButton"));
    return lines.join("\n");
  }

  function summarizeCleanupPlan(plan) {
    return {
      quarantineCount: plan.quarantineCandidates.length,
      quarantineBytes: sum(plan.quarantineCandidates.map((candidate) => candidate.bytes)),
      deleteCount: plan.deleteCandidates.length,
      deleteBytes: sum(plan.deleteCandidates.map((candidate) => candidate.bytes)),
      protectedCount: plan.protectedCount,
      recentCount: plan.recentCount
    };
  }

  async function applyCleanupPlan(plan, action) {
    if (!["quarantine", "delete", "both"].includes(action)) {
      throw new Error(`Unsupported cleanup action: ${action}`);
    }
    const result = { quarantined: 0, deleted: 0, skipped: 0, errors: [] };
    const artifact = await createCleanupArtifact({
      plan,
      action,
      cleanupArtifactDir: policy.artifactDir,
      dateKey: policy.dateKey()
    });
    result.artifactDir = artifact.dir;
    result.manifest = artifact.manifest;
    result.restoreScript = "none";
    const operations = [];
    const protectedThreadIds = await inventory.collectProtectedThreadIds();
    const sessionsRoot = path.resolve(policy.sessionsDir);

    if (action === "quarantine" || action === "both") {
      for (const candidate of plan.quarantineCandidates) {
        try {
          if (protectedThreadIds.has(candidate.threadId)) {
            result.skipped += 1;
            continue;
          }
          const sourcePath = path.resolve(candidate.path);
          if (!isPathInside(sourcePath, sessionsRoot)) {
            throw new Error(`Refusing to quarantine outside sessions dir: ${candidate.path}`);
          }
          const relativePath = path.relative(sessionsRoot, sourcePath);
          const targetPath = path.join(
            policy.quarantineDir,
            policy.dateKey(),
            "sessions",
            relativePath
          );
          await anchoredMove(sessionsRoot, sourcePath, candidate.identity, policy.quarantineDir, targetPath,
            `${JSON.stringify({ threadId: candidate.threadId, originalPath: candidate.path,
              quarantinedAt: now().toISOString() }, null, 2)}\n`);
          operations.push({
            type: "quarantine",
            threadId: candidate.threadId,
            from: sourcePath,
            to: targetPath
          });
          result.quarantined += 1;
        } catch (error) {
          if (error?.code === "ENOENT" && await sourceIsMissing(candidate.path)) {
            result.skipped += 1;
            continue;
          }
          result.errors.push(
            `${candidate.threadId}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    }

    if (action === "delete" || action === "both") {
      const quarantineRoot = path.resolve(policy.quarantineDir);
      for (const candidate of plan.deleteCandidates) {
        try {
          if (protectedThreadIds.has(candidate.threadId)) {
            result.skipped += 1;
            continue;
          }
          const deletePath = path.resolve(candidate.path);
          if (!isPathInside(deletePath, quarantineRoot)) {
            throw new Error(`Refusing to delete outside quarantine dir: ${candidate.path}`);
          }
          const stat = await fs.lstat(deletePath);
          if (!stat.isFile() || await fs.realpath(deletePath) !== deletePath) {
            throw new Error(`Refusing to delete a non-regular or linked quarantine file: ${candidate.path}`);
          }
          const metadata = await readQuarantineMetadata(deletePath);
          const quarantinedAt = metadata?.quarantinedAt
            ? Date.parse(metadata.quarantinedAt)
            : stat.mtimeMs;
          const cutoff = now().getTime() - policy.quarantineDays() * 86_400_000;
          if (!Number.isFinite(quarantinedAt) || quarantinedAt >= cutoff
              || protectedThreadIds.has(metadata?.threadId)) {
            result.skipped += 1;
            continue;
          }
          // Permanent deletion retains only the small operation receipt, never a payload copy.
          await anchoredUnlink(quarantineRoot, deletePath, candidate.identity);
          operations.push({
            type: "delete",
            threadId: candidate.threadId,
            from: deletePath,
            irreversible: true
          });
          result.deleted += 1;
          const metadataPath = `${deletePath}.cleanup.json`;
          const metadataStat = await fs.lstat(metadataPath).catch(() => null);
          if (metadataStat?.isFile()) await anchoredUnlink(quarantineRoot, metadataPath, fileIdentity(metadataStat));
        } catch (error) {
          if (error?.code === "ENOENT" && await sourceIsMissing(candidate.path)) {
            result.skipped += 1;
            continue;
          }
          result.errors.push(
            `${candidate.threadId}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    }

    if (operations.some((operation) => operation.type === "quarantine")) {
      result.restoreScript = artifact.restoreScript;
    }
    await finalizeCleanupArtifact(artifact, operations, result);
    return result;
  }

  function formatCleanupMaintenanceSummaryLines(report) {
    if (!report) return [];
    if (!report.ok) {
      return [
        "",
        b(t("cleanupMaintenanceCheck")),
        msg("ui.maintenanceReport", { error: code(report.error || msg("ui.unavailable")) })
      ];
    }
    const sessions = report.sessions || {};
    const logs = report.logs || {};
    const metadata = report.metadataBloat || {};
    const staleWorktrees = report.staleWorktrees || {};
    const configPrune = report.configPrune || {};
    return [
      "",
      b(t("cleanupMaintenanceCheck")),
      msg("ui.maintenanceSessions", { count: code(formatCount(sessions.files ?? 0)), size: code(formatBytes(sessions.bytes ?? 0)) }),
      msg("ui.maintenanceLogs", { size: code(formatBytes(logs.bytes ?? 0)), threshold: code(`${logs.rotateThresholdMb ?? policy.maintenanceLogRotateMb}MB`) }),
      msg("ui.maintenanceWorktrees", { count: code(formatCount(staleWorktrees.candidates ?? 0)) }),
      `- ${t("cleanupMaintenanceConfigPruneCandidates")}: ${code(formatCount(configPrune.candidates ?? 0))}`,
      msg("ui.maintenanceMetadata", { titles: code(metadata.titlesOverLimit ?? 0), previews: code(metadata.previewsOverLimit ?? 0) })
    ];
  }

  return {
    applyCleanupPlan,
    cleanupKeyboard,
    createCleanupPlan,
    formatCleanupPlanHtml,
    runDailyCleanup,
    sendCleanupPlan,
    sendDailyCleanupPlan,
    summarizeCleanupPlan
  };
}

async function readQuarantineMetadata(file) {
  const metadataPath = `${file}.cleanup.json`;
  try {
    const stat = await fs.lstat(metadataPath);
    if (!stat.isFile()) throw new Error("Quarantine metadata must be a regular file");
    return JSON.parse(await fs.readFile(metadataPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function sourceIsMissing(file) {
  try {
    await fs.lstat(file);
    return false;
  } catch (error) {
    return error?.code === "ENOENT";
  }
}

function isPathInside(candidatePath, rootPath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function emptyCleanupResult() {
  return {
    quarantined: 0,
    deleted: 0,
    skipped: 0,
    errors: [],
    manifest: "none",
    restoreScript: "none"
  };
}

function emptyCleanupPlan() {
  return { quarantineCandidates: [], deleteCandidates: [] };
}
