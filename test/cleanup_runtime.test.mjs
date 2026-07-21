import test from "node:test";
import assert from "node:assert/strict";
import { createCleanupRuntime } from "../src/maintenance/cleanup_runtime.js";

function createFixture() {
  const calls = [];
  const state = {
    chats: { one: { threadId: "11111111-1111-1111-1111-111111111111" } },
    cleanup: {
      lastDailyDate: "",
      plans: {
        expired: { expiresAt: "2026-07-20T00:00:00Z" },
        current: { expiresAt: "2026-07-22T00:00:00Z" }
      }
    },
    uploadCleanup: { plans: {} }
  };
  const controller = createCleanupRuntime({
    settings: {
      config: {
        cleanupLogFile: "/tmp/not-used-cleanup.log",
        cleanupQuarantineDir: "/tmp/quarantine",
        codexSessionsDir: "/tmp/sessions",
        uploadCleanupEnabled: false,
        uploadDir: "/tmp/uploads",
        uploadMaxBytes: 0,
        uploadRetentionDays: 7
      },
      runtimeValue(key) {
        if (key === "cleanupEnabled") return true;
        if (key === "cleanupNotifyTime") return "03:00";
        if (key === "cleanupRetentionDays" || key === "cleanupQuarantineDays") return 7;
        return undefined;
      }
    },
    state,
    activeTurns: new Map(),
    threadCache: new Map([["two", { id: "22222222-2222-2222-2222-222222222222" }]]),
    sessions: { listFiles: async () => [], readMeta: async () => null },
    cleanup: { sendDailyPlan: async () => calls.push(["dailyPlan"]) },
    maintenance: {
      autoHandoffEnabled: () => false,
      autoSqliteRepairEnabled: () => false,
      createThreadHandoff: async () => ({}),
      run: async () => ({})
    },
    telegram: {
      editOrReplyHtml: async (...args) => calls.push(["edit", ...args]),
      summarizeError: String
    },
    localization: {
      formatText: (key, values) => `${key}:${values.action ?? ""}`,
      text: (key) => key
    },
    formatting: {
      count: String,
      localClock: () => ({ dateKey: "2026-07-21", time: "04:00" })
    },
    persistence: { save: async () => calls.push(["save"]) },
    uploads: {
      buildPlan: async () => ({}),
      createPlanLogEntry: () => ({}),
      shouldRun: () => false
    },
    timers: { setTimeout() {}, setInterval() {} },
    runProcess: async () => ({
      stdout: [
        "node unrelated 33333333-3333-3333-3333-333333333333",
        "codex resume 44444444-4444-4444-4444-444444444444"
      ].join("\n")
    }),
    now: () => new Date("2026-07-21T00:00:00Z")
  });
  return { calls, controller, state };
}

test("cleanup runtime protects saved, cached, and running Codex threads", async () => {
  const { controller } = createFixture();
  const protectedIds = await controller.collectProtectedThreadIds();
  assert.deepEqual([...protectedIds].sort(), [
    "11111111-1111-1111-1111-111111111111",
    "22222222-2222-2222-2222-222222222222",
    "44444444-4444-4444-4444-444444444444"
  ]);
});

test("daily cleanup runs once, prunes expired plans, and persists the date", async () => {
  const { calls, controller, state } = createFixture();
  await controller.runDailyCleanupCheck();
  assert.equal(state.cleanup.lastDailyDate, "2026-07-21");
  assert.equal(state.cleanup.plans.expired, undefined);
  assert.ok(state.cleanup.plans.current);
  assert.deepEqual(calls, [["dailyPlan"], ["save"]]);
  await controller.runDailyCleanupCheck();
  assert.deepEqual(calls, [["dailyPlan"], ["save"]]);
});

test("cleanup callback rendering keeps the action and candidate totals", () => {
  const { controller } = createFixture();
  const html = controller.formatCleanupResultHtml("both", {
    quarantined: 2,
    deleted: 1,
    skipped: 0,
    errors: [],
    manifest: "manifest.json",
    restoreScript: "restore.py"
  }, {
    quarantineCandidates: [{}, {}],
    deleteCandidates: [{}]
  });
  assert.match(html, /cleanupActionBoth/);
  assert.match(html, /manifest\.json/);
});
