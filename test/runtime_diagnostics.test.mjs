import test from "node:test";
import assert from "node:assert/strict";
import { createRuntimeDiagnostics } from "../src/status/runtime_diagnostics.js";

function createFixture() {
  const state = { chats: {}, worker: { deliveries: {} } };
  const activeTurns = new Map();
  const pending = [];
  const diagnostics = createRuntimeDiagnostics({
    settings: {
      config: { botRestartRecoveryEnabled: false },
      runtimeValue(key) {
        if (key === "telegramPendingTurnsMax") return 5;
        if (key === "telegramPendingTurnMaxAgeSeconds") return 3600;
        return 0;
      },
      packageFile: "/tmp/package.json"
    },
    state,
    activeTurns,
    threadCache: new Map(),
    chats: { get: () => ({}) },
    options: { get: () => ({}), format: () => "options" },
    queue: {
      countPendingTurns: () => pending.length,
      countSideTurns: () => 0,
      isPaused: () => false,
      mode: () => "safe",
      pending: () => pending,
      sideTurnCount: () => 0
    },
    sessions: { listRecent: async () => [] },
    usage: { buildSummary: async () => "usage" },
    models: { list: async () => [] },
    uploads: { createCleanupPlan: async () => null },
    localization: {
      formatText: (key, values) => `${key}:${values.count}`,
      locale: () => "en-US",
      text: (key) => key,
      timeZone: () => "UTC"
    },
    formatting: {
      bytes: (value) => `${value} B`,
      count: String,
      dateTime: () => "date",
      duration: (value) => `${value}s`,
      keyValue: (title, rows) => `${title}\n${rows.map(([key, value]) => `${key}:${value}`).join("\n")}`,
      truncate: (value, max) => String(value).slice(0, max)
    },
    packages: { readJson: async () => ({}), readPackage: async () => ({}) },
    now: () => Date.parse("2026-07-21T00:00:00Z")
  });
  return { diagnostics, activeTurns, pending };
}

test("runtime diagnostics builds status details from domain stores", async () => {
  const { diagnostics } = createFixture();
  const details = await diagnostics.buildStatusDetails("chat");
  assert.equal(details.active, false);
  assert.equal(details.queueMode, "safe");
  assert.equal(details.usageSummary, "usage");
});

test("runtime diagnostics renders queue entries and status without reading runtime globals", async () => {
  const { diagnostics, activeTurns, pending } = createFixture();
  activeTurns.set("chat", { currentTurnStartedAt: "2026-07-20T23:59:00Z", currentText: "work" });
  pending.push({
    id: "turn",
    text: "queued",
    imagePaths: [],
    enqueuedAt: "2026-07-21T00:00:00Z",
    expiresAt: "2026-07-21T01:00:00Z"
  });
  const queueHtml = diagnostics.formatQueueHtml("chat");
  assert.match(queueHtml, /queued/);
  assert.match(queueHtml, /turn/);

  const details = await diagnostics.buildStatusDetails("chat");
  const statusHtml = diagnostics.formatStatusHtml("chat", details);
  assert.match(statusHtml, /Active turn/);
  assert.match(statusHtml, /options/);
});

test("pending delivery lines distinguish safe and uncertain recovery", () => {
  const { diagnostics } = createFixture();
  assert.deepEqual(diagnostics.formatPendingDeliveryLines({
    count: 1,
    status: "uncertain",
    recovery: "manual_review_required"
  }), [
    "deliveryCodexExecutionCompleted",
    "telegramDeliveryUncertain:1",
    "telegramDeliveryManualReview"
  ]);
});

test("runtime diagnostics facade preserves its stable method surface", () => {
  const { diagnostics } = createFixture();
  assert.deepEqual(Object.keys(diagnostics).sort(), [
    "buildStatusDetails",
    "formatDoctorHtml",
    "formatHealthHtml",
    "formatPendingDeliveryLines",
    "formatQueueHtml",
    "formatQueueModeHtml",
    "formatRecoveryStatusHtml",
    "formatRestartRecoveredHtml",
    "formatRestartScheduledHtml",
    "formatStatusHtml"
  ]);
});
