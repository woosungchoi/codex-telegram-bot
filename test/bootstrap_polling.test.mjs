import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { Telegraf } from "telegraf";
import { bootstrapBot } from "../src/app/bootstrap.js";

async function harness(t, bot) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bootstrap-polling-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const events = [];
  const processRef = new EventEmitter();
  return {
    events,
    processRef,
    options: {
      bot,
      config: {
        codexWorkdir: root,
        uploadDir: root,
        cleanupQuarantineDir: root,
        backupDir: root,
      },
      ensureDirectory: async () => {},
      registerTelegramCommands: async () => {},
      startCleanupScheduler() {},
      startStateSnapshotScheduler() {},
      startPersistedQueues() {
        events.push("queues");
        return () => events.push("cancel");
      },
      processRef,
      logger: { log: () => events.push("started"), warn() {} },
    },
  };
}

test("real Telegraf starts saved queues during polling and cancels startup on shutdown", async (t) => {
  const bot = new Telegraf("test-token");
  let ready;
  const polling = new Promise((resolve) => {
    ready = resolve;
  });
  bot.telegram.callApi = async (method, payload, controller) => {
    if (method === "getMe")
      return {
        id: 123,
        is_bot: true,
        first_name: "test",
        username: "test_bot",
      };
    if (method === "deleteWebhook") return true;
    if (method === "getUpdates" && payload.limit === 1) return [];
    assert.equal(method, "getUpdates");
    ready();
    return new Promise((_resolve, reject) => {
      controller.signal.addEventListener(
        "abort",
        () =>
          reject(Object.assign(new Error("stopped"), { name: "AbortError" })),
        { once: true },
      );
    });
  };
  const h = await harness(t, bot);
  const running = bootstrapBot(h.options);
  await polling;
  assert.deepEqual(h.events, ["started", "queues"]);
  h.processRef.emit("SIGTERM");
  await running;
  assert.equal(h.events.filter((e) => e === "queues").length, 1);
  assert.ok(h.events.includes("cancel"));
});

test("failed launch cancels queued startup and preserves the launch error", async (t) => {
  const failure = new Error("webhook setup failed");
  const h = await harness(t, {
    async launch(onLaunch) {
      onLaunch();
      throw failure;
    },
  });
  await assert.rejects(bootstrapBot(h.options), (error) => error === failure);
  assert.deepEqual(h.events, ["started", "queues", "cancel"]);
});

test("shutdown before identity readiness never starts saved queues", async (t) => {
  const bot = {
    stop() {},
    async launch(onLaunch) {
      h.processRef.emit("SIGTERM");
      onLaunch();
    },
  };
  const h = await harness(t, bot);
  await bootstrapBot(h.options);
  assert.deepEqual(h.events, []);
});
