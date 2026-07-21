export function createCleanupScheduler({
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
}) {
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

  return {
    pruneExpiredCleanupPlans,
    pruneExpiredUploadCleanupPlans,
    runDailyCleanupCheck,
    startCleanupScheduler
  };
}
