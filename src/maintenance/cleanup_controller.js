import fs from "node:fs/promises";
import path from "node:path";
import {
  copyCleanupBackup,
  createCleanupArtifact,
  finalizeCleanupArtifact
} from "./cleanup.js";
import {
  ensurePrivateDirectory,
  hardenPrivateTree,
  writePrivateFile
} from "../fs/private.js";
import { b, code } from "../telegram/html.js";

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
    formatCount
  } = formatting;

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

  function cleanupKeyboard(planId) {
    const plan = stateStore.plans[planId];
    const quarantineCount = plan?.quarantineCandidates?.length ?? 0;
    const deleteCount = plan?.deleteCandidates?.length ?? 0;
    return {
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
    };
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
    const result = { quarantined: 0, deleted: 0, skipped: 0, errors: [] };
    const artifact = await createCleanupArtifact({
      plan,
      action,
      cleanupArtifactDir: policy.artifactDir,
      dateKey: policy.dateKey()
    });
    result.artifactDir = artifact.dir;
    result.manifest = artifact.manifest;
    result.restoreScript = artifact.restoreScript;
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
          await ensurePrivateDirectory(path.dirname(targetPath));
          await fs.rename(sourcePath, targetPath);
          await hardenPrivateTree(targetPath);
          await writePrivateFile(
            `${targetPath}.cleanup.json`,
            `${JSON.stringify({
              threadId: candidate.threadId,
              originalPath: candidate.path,
              quarantinedAt: now().toISOString()
            }, null, 2)}\n`,
            "utf8"
          );
          operations.push({
            type: "quarantine",
            threadId: candidate.threadId,
            from: sourcePath,
            to: targetPath
          });
          result.quarantined += 1;
        } catch (error) {
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
          const deletePath = path.resolve(candidate.path);
          if (!isPathInside(deletePath, quarantineRoot)) {
            throw new Error(`Refusing to delete outside quarantine dir: ${candidate.path}`);
          }
          const relativePath = path.relative(quarantineRoot, deletePath);
          const backupPath = path.join(artifact.deleteBackupDir, relativePath);
          await copyCleanupBackup(deletePath, backupPath);
          await copyCleanupBackup(
            `${deletePath}.cleanup.json`,
            `${backupPath}.cleanup.json`
          ).catch((error) => {
            if (error?.code !== "ENOENT") throw error;
          });
          await fs.rm(deletePath, { force: true });
          await fs.rm(`${deletePath}.cleanup.json`, { force: true });
          operations.push({
            type: "delete",
            threadId: candidate.threadId,
            from: deletePath,
            backup: backupPath
          });
          result.deleted += 1;
        } catch (error) {
          result.errors.push(
            `${candidate.threadId}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
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
        `- report: ${code(report.error || "unavailable")}`
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
      `- sessions: ${code(formatCount(sessions.files ?? 0))} / ${code(formatBytes(sessions.bytes ?? 0))}`,
      `- logs: ${code(formatBytes(logs.bytes ?? 0))} / rotate ${code(`${logs.rotateThresholdMb ?? policy.maintenanceLogRotateMb}MB`)}`,
      `- stale worktrees: ${code(formatCount(staleWorktrees.candidates ?? 0))}`,
      `- ${t("cleanupMaintenanceConfigPruneCandidates")}: ${code(formatCount(configPrune.candidates ?? 0))}`,
      `- metadata bloat: title ${code(metadata.titlesOverLimit ?? 0)} / preview ${code(metadata.previewsOverLimit ?? 0)}`
    ];
  }

  return {
    applyCleanupPlan,
    cleanupKeyboard,
    createCleanupPlan,
    formatCleanupPlanHtml,
    sendCleanupPlan,
    sendDailyCleanupPlan,
    summarizeCleanupPlan
  };
}

function isPathInside(candidatePath, rootPath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}
