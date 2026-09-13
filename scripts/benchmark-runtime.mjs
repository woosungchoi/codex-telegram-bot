import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { Telegraf } from "telegraf";
import { bootstrapBot } from "../src/app/bootstrap.js";
import { createWorkerStore } from "../src/worker/store.js";
import { workspaceState } from "../src/workspace/store.js";
import { saveRuntimeState } from "../src/runtime/state_store.js";
import { createWorkerRuntimeController } from "../src/worker/runtime_controller.js";
const scratch = await fs.mkdtemp(
  path.join(os.tmpdir(), "codex-optimization-audit-"),
);
const result = { node: process.version, synthetic: true };
const noop = () => {};
try {
  const bot = new Telegraf("0:local-test-no-network");
  let signalReady;
  const pollingReady = new Promise((resolve) => (signalReady = resolve));
  bot.telegram.callApi = async (method, data, options) => {
    if (method === "getMe")
      return { id: 1, is_bot: true, first_name: "Test", username: "test_bot" };
    if (method === "deleteWebhook") return true;
    if (method === "getUpdates" && data.limit === 1) return [];
    if (method === "getUpdates")
      return new Promise((resolve, reject) => {
        options.signal.addEventListener(
          "abort",
          () =>
            reject(Object.assign(new Error("Stopped"), { name: "AbortError" })),
          { once: true },
        );
        signalReady();
      });
    throw new Error(`Unexpected API ${method}`);
  };
  let queues = 0,
    started = 0;
  const run = bootstrapBot({
    bot,
    config: {
      codexWorkdir: scratch,
      uploadDir: path.join(scratch, "uploads"),
      cleanupQuarantineDir: path.join(scratch, "quarantine"),
      backupDir: path.join(scratch, "backups"),
    },
    ensureDirectory: async () => {},
    registerTelegramCommands: async () => {},
    startCleanupScheduler: noop,
    startStateSnapshotScheduler: noop,
    startPersistedQueues: () => queues++,
    processRef: { once: noop },
    logger: { log: () => started++, warn: noop },
  });
  await pollingReady;
  const whilePolling = { queueStartupCalls: queues, startupLogCalls: started };
  bot.stop("audit-finished");
  await run;
  result.bootstrap = {
    realTelegrafLaunchAndPolling: true,
    networkCalls: 0,
    whilePolling,
    afterPollingStops: { queueStartupCalls: queues, startupLogCalls: started },
  };
  const store = createWorkerStore({
    codexWorkerStateDir: path.join(scratch, "worker"),
  });
  await store.ensure();
  const median = (values) =>
    [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  async function measure(fn, count = 7) {
    for (let i = 0; i < 2; i++) await fn();
    const samples = [];
    for (let i = 0; i < count; i++) {
      const start = performance.now();
      await fn();
      samples.push(performance.now() - start);
    }
    return {
      medianMs: +median(samples).toFixed(3),
      minMs: +Math.min(...samples).toFixed(3),
      maxMs: +Math.max(...samples).toFixed(3),
    };
  }
  result.eventPolling = [];
  for (const mib of [1, 8, 32]) {
    const lines = [];
    let bytes = 0;
    while (bytes < mib * 1024 ** 2) {
      const line =
        JSON.stringify({
          seq: lines.length + 1,
          type: "item.updated",
          item: { id: "example", type: "agent_message", text: "x".repeat(440) },
        }) + "\n";
      lines.push(line);
      bytes += Buffer.byteLength(line);
    }
    const eventFile = path.join(store.paths.eventsDir, "bench.jsonl");
    await fs.writeFile(eventFile, lines.join(""));
    const rows = lines.length;
    const current = await measure(async () =>
      assert.equal(
        (await store.readJobEvents("bench", { afterSeq: rows, limit: 500 }))
          .length,
        0,
      ),
    );
    result.eventPolling.push({
      bytes,
      rows,
      noNewEvents: true,
      warmIndex: current,
    });
  }
  result.workspaceValidation = [];
  for (const entries of [0, 1000, 10000]) {
    const state = {
      workspace: {
        projects: {
          owner: Array.from({ length: entries }, (_, i) => ({
            id: String(i),
            name: "project",
            cwd: "/workspace",
          })),
        },
        tasks: Object.fromEntries(
          Array.from({ length: entries }, (_, i) => [
            String(i),
            { id: String(i), enabled: true },
          ]),
        ),
        flows: {},
        panels: {},
        panelPreferences: {},
      },
    };
    workspaceState(state);
    result.workspaceValidation.push({
      projects: entries,
      tasks: entries,
      perCall: await measure(() => {
        for (let i = 0; i < 20; i++) workspaceState(state);
      }, 7),
    });
    for (const key of Object.keys(result.workspaceValidation.at(-1).perCall))
      result.workspaceValidation.at(-1).perCall[key] = +(
        result.workspaceValidation.at(-1).perCall[key] / 20
      ).toFixed(4);
  }
  result.stateWrites = [];
  for (const kib of [20, 1024]) {
    const value = {
      chats: { one: { text: "x".repeat(kib * 1024) } },
      worker: { deliveries: {} },
    };
    const elapsed = await measure(async () => {
      for (let i = 0; i < 50; i++)
        await saveRuntimeState(path.join(scratch, "state.json"), value);
    }, 3);
    result.stateWrites.push({
      approxKiB: kib,
      writesPerSample: 50,
      ...elapsed,
    });
  }
  const delivery = {};
  const chat = {};
  let saves = 0,
    polls = 0;
  const events = Array.from({ length: 100 }, (_, i) => ({
    seq: i + 1,
    type: "probe.event",
  }));
  events.push({ seq: 101, type: "worker.job.completed", status: "completed" });
  const controller = createWorkerRuntimeController({
    settings: { recoveryEnabled: false, eventPollMs: () => 1 },
    deliveryStore: {
      get: (key) => delivery[key],
      set: (key, value) => (delivery[key] = value),
      save: async () => saves++,
    },
    chatStore: { get: () => chat },
    worker: {
      getClient: () => ({
        readJobEvents: async () => {
          polls++;
          return { events };
        },
      }),
    },
    turn: {
      recordCodexStreamStarted: noop,
      recordCodexStreamUnknownEvent: noop,
      maybeSendLiveProgress: noop,
      recordCodexStreamIteratorClosed: noop,
    },
    recovery: {},
    sleep: noop,
  });
  await controller.waitForWorkerJob({}, "chat", "job", {}, {});
  result.cursorPersistence = {
    eventCount: events.length,
    polls,
    fullStateSaves: saves,
    recoverySnapshotDisabled: true,
  };
  console.log(JSON.stringify(result, null, 2));
} finally {
  await fs.rm(scratch, { recursive: true, force: true });
}
