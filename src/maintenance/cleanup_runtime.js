import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { appendPrivateFile } from "../fs/private.js";
import { createCleanupInventory } from "./cleanup_inventory.js";
import { createCleanupScheduler } from "./cleanup_scheduler.js";
import { createCleanupUi } from "./cleanup_ui.js";

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
  const ui = createCleanupUi({ telegram, localization, formatting });
  const inventory = createCleanupInventory({
    settings,
    state,
    threadCache,
    sessions,
    runProcess,
    now
  });

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

  const scheduler = createCleanupScheduler({
    settings,
    state,
    activeTurns,
    cleanup,
    maintenance,
    formatting,
    persistence,
    uploads,
    timers,
    appendCleanupLog,
    createUploadCleanupPlan,
    now
  });

  return {
    answerCleanupCallback: ui.answerCleanupCallback,
    answerUploadCleanupCallback: ui.answerUploadCleanupCallback,
    appendCleanupLog,
    collectProtectedThreadIds: inventory.collectProtectedThreadIds,
    createUploadCleanupPlan,
    editCleanupMessage: ui.editCleanupMessage,
    editCleanupProcessingMessage: ui.editCleanupProcessingMessage,
    editUploadCleanupMessage: ui.editUploadCleanupMessage,
    formatCleanupIgnoredHtml: ui.formatCleanupIgnoredHtml,
    formatCleanupResultHtml: ui.formatCleanupResultHtml,
    listCleanupSessionFiles: inventory.listCleanupSessionFiles,
    listQuarantineDeleteCandidates: inventory.listQuarantineDeleteCandidates,
    pruneExpiredCleanupPlans: scheduler.pruneExpiredCleanupPlans,
    pruneExpiredUploadCleanupPlans: scheduler.pruneExpiredUploadCleanupPlans,
    runDailyCleanupCheck: scheduler.runDailyCleanupCheck,
    startCleanupScheduler: scheduler.startCleanupScheduler
  };
}
