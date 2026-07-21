import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCleanupController } from "../src/maintenance/cleanup_controller.js";

const FIXED_NOW = new Date("2026-07-21T03:04:05.000Z");

function createHarness({ root, sessionScan, deleteCandidates = [], protectedIds = [] }) {
  const plans = {};
  const logs = [];
  const sent = [];
  const sessionsDir = path.join(root, "sessions");
  const quarantineDir = path.join(root, "quarantine");
  const artifactDir = path.join(root, "artifacts");
  const controller = createCleanupController({
    stateStore: {
      plans,
      prunePlans: () => logs.push({ type: "prune" }),
      save: async () => logs.push({ type: "save" }),
      appendLog: async (entry) => logs.push(entry)
    },
    policy: {
      planTtlHours: () => 12,
      retentionDays: () => 30,
      quarantineDays: () => 14,
      artifactDir,
      sessionsDir,
      quarantineDir,
      notifyChatIds: ["101"],
      maintenanceLogRotateMb: 25,
      dateKey: () => "20260721"
    },
    inventory: {
      collectProtectedThreadIds: async () => new Set(protectedIds),
      listSessionFiles: async () => sessionScan ?? {
        protectedCount: 0,
        recentCount: 0,
        candidates: []
      },
      listDeleteCandidates: async () => deleteCandidates,
      readMaintenanceReport: async () => ({
        ok: true,
        sessions: { files: 2, bytes: 100 },
        logs: { bytes: 200, rotateThresholdMb: 50 },
        staleWorktrees: { candidates: 1 },
        configPrune: { candidates: 3 },
        metadataBloat: { titlesOverLimit: 4, previewsOverLimit: 5 }
      })
    },
    telegram: {
      replyHtml: async (...args) => sent.push(["reply", ...args]),
      sendHtmlMessage: async (...args) => sent.push(["send", ...args])
    },
    formatting: {
      text: (key) => key,
      formatText: (key, values) => `${key}:${JSON.stringify(values)}`,
      formatBytes: (value) => `${value}B`,
      formatDateTime: (value) => value,
      formatCount: (value) => String(value)
    },
    now: () => new Date(FIXED_NOW),
    random: () => 0.5
  });
  return { artifactDir, controller, logs, plans, quarantineDir, sent, sessionsDir };
}

async function createFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cleanup-controller-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test("cleanup controller creates a deterministic approval plan and renders its controls", async (t) => {
  const root = await createFixture(t);
  const candidate = {
    threadId: "thread-<unsafe>",
    path: path.join(root, "sessions", "thread.jsonl"),
    ageDays: 31,
    bytes: 125
  };
  const deletion = {
    threadId: "old-thread",
    path: path.join(root, "quarantine", "old.jsonl"),
    quarantineAgeDays: 15,
    bytes: 75
  };
  const harness = createHarness({
    root,
    sessionScan: {
      protectedCount: 2,
      recentCount: 3,
      candidates: [candidate]
    },
    deleteCandidates: [deletion]
  });

  const plan = await harness.controller.createCleanupPlan("manual");

  assert.equal(plan.source, "manual");
  assert.equal(plan.createdAt, "2026-07-21T03:04:05.000Z");
  assert.equal(plan.expiresAt, "2026-07-21T15:04:05.000Z");
  assert.equal(harness.plans[plan.id], plan);
  assert.deepEqual(harness.logs[0], { type: "prune" });
  assert.deepEqual(harness.logs[1].summary, {
    quarantineCount: 1,
    quarantineBytes: 125,
    deleteCount: 1,
    deleteBytes: 75,
    protectedCount: 2,
    recentCount: 3
  });

  const keyboard = harness.controller.cleanupKeyboard(plan.id);
  assert.deepEqual(
    keyboard.reply_markup.inline_keyboard.flat().map((button) => button.callback_data),
    [
      `cleanup:quarantine:${plan.id}`,
      `cleanup:delete:${plan.id}`,
      `cleanup:both:${plan.id}`,
      `cleanup:ignore:${plan.id}`
    ]
  );
  const html = harness.controller.formatCleanupPlanHtml(plan);
  assert.match(html, /thread-&lt;unsafe&gt;/);
  assert.match(html, /cleanupMaintenanceConfigPruneCandidates/);
  assert.match(html, /cleanupNoFilesUntilButton/);
});

test("cleanup controller refuses candidates outside the configured roots", async (t) => {
  const root = await createFixture(t);
  const outsideQuarantine = path.join(root, "outside-session.jsonl");
  const outsideDelete = path.join(root, "outside-delete.jsonl");
  await fs.writeFile(outsideQuarantine, "session\n");
  await fs.writeFile(outsideDelete, "delete\n");
  const harness = createHarness({ root });
  const plan = {
    id: "outside-roots",
    quarantineCandidates: [
      { threadId: "session", path: outsideQuarantine, ageDays: 40, bytes: 8 }
    ],
    deleteCandidates: [
      { threadId: "delete", path: outsideDelete, quarantineAgeDays: 20, bytes: 7 }
    ]
  };

  const result = await harness.controller.applyCleanupPlan(plan, "both");

  assert.equal(result.quarantined, 0);
  assert.equal(result.deleted, 0);
  assert.equal(result.errors.length, 2);
  assert.match(result.errors[0], /outside sessions dir/);
  assert.match(result.errors[1], /outside quarantine dir/);
  assert.equal(await fs.readFile(outsideQuarantine, "utf8"), "session\n");
  assert.equal(await fs.readFile(outsideDelete, "utf8"), "delete\n");
  assert.equal(await fs.readFile(result.manifest, "utf8"), "");
});

test("cleanup controller quarantines an eligible session with restore metadata", async (t) => {
  const root = await createFixture(t);
  const harness = createHarness({ root });
  const source = path.join(harness.sessionsDir, "2026", "thread-a.jsonl");
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.writeFile(source, "session\n");
  const plan = {
    id: "quarantine-one",
    quarantineCandidates: [
      { threadId: "thread-a", path: source, ageDays: 40, bytes: 8 }
    ],
    deleteCandidates: []
  };

  const result = await harness.controller.applyCleanupPlan(plan, "quarantine");
  const target = path.join(
    harness.quarantineDir,
    "20260721",
    "sessions",
    "2026",
    "thread-a.jsonl"
  );

  assert.equal(result.quarantined, 1);
  assert.equal(result.deleted, 0);
  assert.deepEqual(result.errors, []);
  await assert.rejects(fs.access(source));
  assert.equal(await fs.readFile(target, "utf8"), "session\n");
  assert.deepEqual(JSON.parse(await fs.readFile(`${target}.cleanup.json`, "utf8")), {
    threadId: "thread-a",
    originalPath: source,
    quarantinedAt: "2026-07-21T03:04:05.000Z"
  });
  const manifest = JSON.parse((await fs.readFile(result.manifest, "utf8")).trim());
  assert.deepEqual(manifest, {
    type: "quarantine",
    threadId: "thread-a",
    from: source,
    to: target
  });
});

test("cleanup controller skips sessions that become protected after planning", async (t) => {
  const root = await createFixture(t);
  const harness = createHarness({ root, protectedIds: ["thread-active"] });
  const source = path.join(harness.sessionsDir, "thread-active.jsonl");
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.writeFile(source, "active\n");

  const result = await harness.controller.applyCleanupPlan({
    id: "protected",
    quarantineCandidates: [
      { threadId: "thread-active", path: source, ageDays: 40, bytes: 7 }
    ],
    deleteCandidates: []
  }, "quarantine");

  assert.equal(result.skipped, 1);
  assert.equal(result.quarantined, 0);
  assert.equal(await fs.readFile(source, "utf8"), "active\n");
});
