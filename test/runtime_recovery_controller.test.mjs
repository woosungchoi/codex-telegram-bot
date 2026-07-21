import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate as waitForImmediate } from "node:timers/promises";
import {
  createRuntimeRecoveryController,
  createWorkerRecoveryTurn,
  isWorkerCancelledMessage
} from "../src/recovery/runtime_controller.js";
import { replaceActiveTurnSnapshot } from "../src/recovery/state.js";

async function createHarness(t, {
  enabled = true,
  workerEnabled = false,
  workerJob = null,
  workerResult = null
} = {}) {
  const recoveryDir = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-recovery-"));
  t.after(() => fs.rm(recoveryDir, { recursive: true, force: true }));
  const activeTurns = new Map();
  const events = [];
  const exits = [];
  const replies = [];
  const stops = [];
  const warnings = [];
  const deliveries = {};
  const deliveryTransitions = [];
  const drains = [];
  const answerReplies = [];
  const completed = [];
  const reactions = [];
  const chat = { threadId: "" };
  const controller = createRuntimeRecoveryController({
    settings: {
      enabled,
      recoveryDir,
      recoveryStaleSeconds: 3600,
      recoverySuspendAfter: 3,
      recoveryTurnTtlSeconds: 7200,
      workingDirectory: "/workspace",
      restartExitCode: 75,
      restartDrainTimeoutSeconds: 0,
      restartDelaySeconds: 0,
      stoppedReaction: "stop",
      errorReaction: "error",
      completeReaction: "done"
    },
    stateStore: {
      activeTurns,
      getWorkerDeliveries: () => deliveries,
      replaceWorkerDeliveries: (next) => Object.assign(deliveries, next),
      getChat: () => chat,
      save: async () => {}
    },
    queue: {
      enqueueFrontForced: async () => {},
      dequeue: async () => null,
      startPrepared: async () => {},
      startDrain: async (...args) => drains.push(args)
    },
    worker: {
      enabled: () => workerEnabled,
      getClient: () => ({
        status: async () => {
          throw new Error("worker unavailable");
        },
        getJobStatus: async () => ({ job: workerJob })
      }),
      waitForJob: async () => {
        if (workerResult) return workerResult;
        throw new Error("unused");
      },
      transport: () => "sdk"
    },
    turn: {
      appendRecoveryEvent: async (event) => events.push(event),
      createCodexThread: () => ({}),
      createLiveProgressState: () => ({}),
      createSyntheticCtx: () => ({}),
      deleteTrackedProgressMessages: async () => {},
      digestText: () => "digest",
      formatTurn: (result) => result?.response || "",
      markActiveTurnStopped: async () => {},
      recordActiveTurnCompleted: async (...args) => completed.push(args),
      recordActiveTurnFailed: async () => {},
      recordTelegramReplyCompleted: async () => deliveryTransitions.push("completed"),
      recordTelegramReplyDigestMismatch: async () => {},
      recordTelegramReplyFailed: async () => deliveryTransitions.push("failed"),
      recordTelegramReplyReady: async () => deliveryTransitions.push("ready"),
      recordTelegramReplyStarted: async () => deliveryTransitions.push("started"),
      shouldDeleteLiveProgress: () => false,
      tryBackfillCompletedStream: async () => false
    },
    telegram: {
      notifyExtra: () => ({}),
      reactQuietly: async (...args) => reactions.push(args),
      replyCodexAnswer: async (...args) => answerReplies.push(args),
      replyHtml: async (...args) => replies.push(args),
      sendHtmlMessage: async () => ({})
    },
    formatting: {
      restartRecovered: () => "recovered",
      restartScheduled: () => "scheduled"
    },
    lifecycle: {
      stopBot: (signal) => stops.push(signal),
      exit: (code) => exits.push(code)
    },
    text: (key) => key,
    sleep: async () => {},
    logger: {
      warn: (...args) => warnings.push(args),
      error: (...args) => warnings.push(args)
    }
  });
  return {
    activeTurns,
    answerReplies,
    completed,
    controller,
    deliveryTransitions,
    drains,
    events,
    exits,
    reactions,
    recoveryDir,
    replies,
    stops,
    warnings
  };
}

test("runtime recovery scheduler records worker health and empty startup plans", async (t) => {
  const { controller, events, warnings } = await createHarness(t, {
    workerEnabled: true
  });

  await controller.startRecoveryScheduler();

  assert.deepEqual(events.map((event) => event.type), [
    "worker_startup_status_failed",
    "worker_delivery_recovery_plan",
    "startup_recovery_plan"
  ]);
  assert.equal(events[1].safe, 0);
  assert.equal(events[2].candidates, 0);
  assert.equal(warnings.length, 1);
});

test("disabled runtime recovery does not initialize or schedule work", async (t) => {
  const { controller, events, recoveryDir } = await createHarness(t, { enabled: false });
  await fs.rm(recoveryDir, { recursive: true, force: true });

  await controller.startRecoveryScheduler();

  assert.deepEqual(events, []);
  await assert.rejects(fs.access(recoveryDir));
});

test("manual recovery with no candidates reports the no-op decision", async (t) => {
  const { controller, events } = await createHarness(t);

  const started = await controller.scheduleStartupRecovery({
    force: true,
    notifyCtx: {},
    source: "manual"
  });

  assert.equal(started, false);
  assert.deepEqual(events.map((event) => event.type), [
    "startup_recovery_plan",
    "manual_recovery_no_candidates"
  ]);
});

test("SIGUSR2 schedules one restart marker and the configured planned exit", async (t) => {
  const { controller, events, exits, recoveryDir } = await createHarness(t);

  await controller.handleProcessSignal("SIGUSR2");
  await waitForImmediate();

  assert.equal(controller.isRestartScheduled(), true);
  assert.deepEqual(exits, [75]);
  assert.equal(events.at(-1).type, "planned_restart_exit");
  const marker = JSON.parse(await fs.readFile(path.join(recoveryDir, "restart-marker.json"), "utf8"));
  assert.equal(marker.mode, "sigusr2");
  assert.equal(marker.requestedBy, "signal");
});

test("direct SIGINT stops Telegram and exits without writing a restart marker", async (t) => {
  const { controller, exits, recoveryDir, stops } = await createHarness(t);

  const handled = await controller.handleProcessSignal("SIGINT");

  assert.equal(handled, undefined);
  assert.deepEqual(stops, ["SIGINT"]);
  assert.deepEqual(exits, [0]);
  await assert.rejects(fs.access(path.join(recoveryDir, "restart-marker.json")));
});

test("worker recovery turns preserve Telegram routing and worker cursor metadata", () => {
  const turn = createWorkerRecoveryTurn("chat:topic", {
    chatId: -1001,
    chatType: "supergroup",
    messageThreadId: 44,
    replyToMessageId: 55,
    originMessageId: 66,
    originUpdateId: 77,
    workerJobId: "job-1",
    workerEventSeq: "9",
    threadId: "thread-1",
    recoveryKey: "recovery-1",
    inputPreview: "resume"
  }, { now: () => 123 });

  assert.equal(turn.id, "worker-recovery-job-1");
  assert.equal(turn.chatKey, "chat:topic");
  assert.equal(turn.chatId, -1001);
  assert.equal(turn.messageThreadId, 44);
  assert.equal(turn.kind, "recovery");
  assert.equal(turn.recovery.workerJobId, "job-1");
  assert.equal(turn.recovery.workerEventSeq, 9);
});

test("worker cancellation detection accepts known worker and abort messages only", () => {
  assert.equal(isWorkerCancelledMessage("The operation was aborted"), true);
  assert.equal(isWorkerCancelledMessage("Worker job was cancelled"), true);
  assert.equal(isWorkerCancelledMessage("Cancelled by Telegram bot"), true);
  assert.equal(isWorkerCancelledMessage("Worker connection failed"), false);
});

test("running worker snapshots resume through final delivery and queue drain", async (t) => {
  const workerJob = {
    id: "job-1",
    status: "running",
    threadId: "thread-1",
    transport: "sdk"
  };
  const harness = await createHarness(t, {
    workerEnabled: true,
    workerJob,
    workerResult: {
      turn: { response: "recovered answer" },
      threadId: "thread-1"
    }
  });
  await replaceActiveTurnSnapshot(harness.recoveryDir, "chat-1", {
    chatId: "chat-1",
    inputPreview: "resume",
    recoveryEligible: true,
    startedAt: new Date().toISOString(),
    workerEventSeq: 4,
    workerJobId: "job-1"
  });

  assert.equal(await harness.controller.recoverActiveWorkerJobs({ source: "test" }), 1);
  for (let index = 0; index < 10; index += 1) {
    if (harness.events.some(({ type }) => type === "worker_recovery_completed")) break;
    await waitForImmediate();
  }

  assert.deepEqual(harness.deliveryTransitions, ["ready", "started", "completed"]);
  assert.equal(harness.answerReplies.length, 1);
  assert.equal(harness.answerReplies[0][1], "recovered answer");
  assert.deepEqual(harness.completed, [["chat-1", "thread-1"]]);
  assert.equal(harness.drains.length, 1);
  assert.equal(harness.activeTurns.has("chat-1"), false);
  assert.deepEqual(
    harness.events.map(({ type }) => type),
    [
      "worker_delivery_recovery_plan",
      "worker_recovery_started",
      "worker_recovery_completed"
    ]
  );
  assert.equal(harness.reactions.at(-1)[1], "done");
});
