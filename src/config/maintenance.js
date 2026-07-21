import path from "node:path";
import {
  parseNonnegativeInteger,
  parseOptionalBoolean,
  parseTelegramIdCsv
} from "./parsers.js";

export function readCodexMaintenanceConfig(env, paths) {
  return {
    codexMaintenanceScript: env.CODEX_MAINTENANCE_SCRIPT?.trim()
      || path.join(paths.appRoot, "scripts", "codex_maintenance.py"),
    codexMaintenanceBackupDir: env.CODEX_MAINTENANCE_BACKUP_DIR?.trim()
      || path.join(paths.stateRoot, "codex-maintenance"),
    codexMaintenanceWorktreeDays: parseNonnegativeInteger(
      env.CODEX_MAINTENANCE_WORKTREE_DAYS,
      7,
      "CODEX_MAINTENANCE_WORKTREE_DAYS"
    ),
    codexMaintenanceLogRotateMb: parseNonnegativeInteger(
      env.CODEX_MAINTENANCE_LOG_ROTATE_MB,
      64,
      "CODEX_MAINTENANCE_LOG_ROTATE_MB"
    ),
    codexMaintenanceThreadTitleLimit: parseNonnegativeInteger(
      env.CODEX_MAINTENANCE_THREAD_TITLE_LIMIT,
      120,
      "CODEX_MAINTENANCE_THREAD_TITLE_LIMIT"
    ),
    codexMaintenanceThreadPreviewLimit: parseNonnegativeInteger(
      env.CODEX_MAINTENANCE_THREAD_PREVIEW_LIMIT,
      240,
      "CODEX_MAINTENANCE_THREAD_PREVIEW_LIMIT"
    ),
    codexMaintenanceAutoSqliteRepairEnabled: parseOptionalBoolean(
      env.CODEX_MAINTENANCE_AUTO_SQLITE_REPAIR_ENABLED
    ) ?? false,
    codexMaintenanceAutoHandoffEnabled: parseOptionalBoolean(
      env.CODEX_MAINTENANCE_AUTO_HANDOFF_ENABLED
    ) ?? false,
    codexHandoffDir: env.CODEX_HANDOFF_DIR?.trim() || path.join(paths.codexHome, "handoffs"),
    codexHandoffRecentEvents: parseNonnegativeInteger(
      env.CODEX_HANDOFF_RECENT_EVENTS,
      40,
      "CODEX_HANDOFF_RECENT_EVENTS"
    )
  };
}

export function readUploadConfig(env, paths) {
  return {
    uploadDir: env.UPLOAD_DIR?.trim() || path.join(paths.stateRoot, "uploads"),
    uploadRetentionDays: parseNonnegativeInteger(
      env.UPLOAD_RETENTION_DAYS,
      7,
      "UPLOAD_RETENTION_DAYS"
    ),
    uploadMaxBytes: parseNonnegativeInteger(
      env.UPLOAD_MAX_BYTES,
      1_073_741_824,
      "UPLOAD_MAX_BYTES"
    ),
    uploadCleanupEnabled: parseOptionalBoolean(env.UPLOAD_CLEANUP_ENABLED) ?? true
  };
}

export function readCleanupConfig(env, paths, allowedUserIds) {
  const cleanupNotifyChatIds = parseTelegramIdCsv(
    env.CLEANUP_NOTIFY_CHAT_IDS,
    "CLEANUP_NOTIFY_CHAT_IDS",
    { allowNegative: true }
  );
  return {
    cleanupEnabled: parseOptionalBoolean(env.CLEANUP_ENABLED) ?? true,
    cleanupNotifyTime: env.CLEANUP_NOTIFY_TIME?.trim() || "09:00",
    cleanupNotifyChatIds: cleanupNotifyChatIds.length > 0
      ? cleanupNotifyChatIds
      : [...allowedUserIds],
    cleanupRetentionDays: parseNonnegativeInteger(
      env.CLEANUP_RETENTION_DAYS,
      14,
      "CLEANUP_RETENTION_DAYS"
    ),
    cleanupQuarantineDays: parseNonnegativeInteger(
      env.CLEANUP_QUARANTINE_DAYS,
      7,
      "CLEANUP_QUARANTINE_DAYS"
    ),
    cleanupQuarantineDir: env.CLEANUP_QUARANTINE_DIR?.trim()
      || path.join(paths.codexHome, "session-quarantine"),
    cleanupLogFile: env.CLEANUP_LOG_FILE?.trim() || path.join(paths.stateRoot, "cleanup-log.jsonl"),
    cleanupArtifactDir: env.CLEANUP_ARTIFACT_DIR?.trim()
      || path.join(paths.stateRoot, "cleanup-artifacts"),
    cleanupPlanTtlHours: parseNonnegativeInteger(
      env.CLEANUP_PLAN_TTL_HOURS,
      24,
      "CLEANUP_PLAN_TTL_HOURS"
    ),
    backupDir: env.BACKUP_DIR?.trim() || path.join(paths.stateRoot, "backups"),
    snapshotEnabled: parseOptionalBoolean(env.SNAPSHOT_ENABLED) ?? true,
    snapshotNotifyTime: env.SNAPSHOT_NOTIFY_TIME?.trim() || "03:30",
    snapshotRetentionDays: parseNonnegativeInteger(
      env.SNAPSHOT_RETENTION_DAYS,
      14,
      "SNAPSHOT_RETENTION_DAYS"
    ),
    logsMaxLines: parseNonnegativeInteger(env.LOGS_MAX_LINES, 80, "LOGS_MAX_LINES")
  };
}
