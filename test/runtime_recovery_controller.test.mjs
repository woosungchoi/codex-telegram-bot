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

async function createHarness(t, { enabled = true, workerEnabled = false } = {}) {
  const recoveryDir = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-recovery-"));
  t.after(() => fs.rm(recoveryDir, { recursive: true, force: true }));
  const activeTurns = new Map();
  const events = [];
  const exits = [];
  const replies = [];
  const stops = [];
  const warnings = [];
  const deliveries = {};
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
      getChat: () => ({ threadId: "" }),
      save: async () => {}
    },
    queue: {
      enqueueFrontForced: async () => {},
      dequeue: async () => null,
      startPrepared: async () => {},
      startDrain: async () => {}
    },
    worker: {
      enabled: () => workerEnabled,
      getClient: () => ({
        status: async () => {
          throw new Error("worker unavailable");
        },
        getJobStatus: async () => ({ job: null })
      }),
      waitForJob: async () => {
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
      formatTurn: () => "",
      markActiveTurnStopped: async () => {},
      recordActiveTurnCompleted: async () => {},
      recordActiveTurnFailed: async () => {},
      recordTelegramReplyCompleted: async () => {},
      recordTelegramReplyDigestMismatch: async () => {},
      recordTelegramReplyFailed: async () => {},
      recordTelegramReplyReady: async () => {},
      recordTelegramReplyStarted: async () => {},
      shouldDeleteLiveProgress: () => false,
      tryBackfillCompletedStream: async () => false
    },
    telegram: {
      notifyExtra: () => ({}),
      reactQuietly: async () => {},
      replyCodexAnswer: async () => {},
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
  return { controller, events, exits, recoveryDir, replies, stops, warnings };
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
