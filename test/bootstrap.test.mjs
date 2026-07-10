import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { bootstrapBot } from "../src/app/bootstrap.js";

function mode(stat) {
  return stat.mode & 0o777;
}

test("bootstrapBot prepares directories, starts schedulers, launches bot, and registers signals", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bot-bootstrap-"));
  const events = [];
  const signals = [];
  const bot = {
    async launch() {
      events.push("launch");
    },
    stop(signal) {
      events.push(`stop:${signal}`);
    }
  };
  const processRef = {
    once(signal, _handler) {
      signals.push(signal);
    }
  };

  await bootstrapBot({
    bot,
    config: {
      codexWorkdir: path.join(root, "work"),
      uploadDir: path.join(root, "uploads"),
      cleanupQuarantineDir: path.join(root, "quarantine"),
      backupDir: path.join(root, "backups"),
      botRecoveryDir: path.join(root, "recovery")
    },
    ensureDirectory: async (dir, label) => {
      events.push(`ensure:${label}`);
      await fs.mkdir(dir, { recursive: true, mode: 0o775 });
      await fs.chmod(dir, 0o775);
    },
    registerTelegramCommands: async () => events.push("commands"),
    startCleanupScheduler: () => events.push("cleanup"),
    startStateSnapshotScheduler: () => events.push("snapshot"),
    startRecoveryScheduler: () => events.push("recovery"),
    startPersistedQueues: () => events.push("queues"),
    handleSignal: async (signal) => {
      events.push(`handle:${signal}`);
      bot.stop(signal);
    },
    processRef,
    logger: { log: (message) => events.push(message), warn: (message) => events.push(message) }
  });

  assert.deepEqual(events, [
    "ensure:CODEX_WORKDIR",
    "cleanup",
    "snapshot",
    "commands",
    "recovery",
    "launch",
    "codex-telegram-bot started",
    "queues"
  ]);
  assert.deepEqual(signals, ["SIGINT", "SIGTERM", "SIGUSR2"]);
  for (const dir of ["work", "uploads", "quarantine", "backups", "recovery"]) {
    assert.equal((await fs.stat(path.join(root, dir))).isDirectory(), true);
  }
  assert.equal(mode(await fs.stat(path.join(root, "work"))), 0o775);
  for (const dir of ["uploads", "quarantine", "backups", "recovery"]) {
    assert.equal(mode(await fs.stat(path.join(root, dir))), 0o700);
  }
});

test("bootstrapBot registered signal handlers call the supplied signal handler", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bot-bootstrap-signal-"));
  const events = [];
  const handlers = new Map();
  const bot = {
    async launch() {
      events.push("launch");
    },
    stop(signal) {
      events.push(`stop:${signal}`);
    }
  };
  const processRef = {
    once(signal, handler) {
      handlers.set(signal, handler);
    }
  };

  await bootstrapBot({
    bot,
    config: {
      codexWorkdir: path.join(root, "work"),
      uploadDir: path.join(root, "uploads"),
      cleanupQuarantineDir: path.join(root, "quarantine"),
      backupDir: path.join(root, "backups"),
      botRecoveryDir: path.join(root, "recovery")
    },
    ensureDirectory: async (dir) => {
      await fs.mkdir(dir, { recursive: true });
    },
    registerTelegramCommands: async () => {},
    startCleanupScheduler: () => {},
    startStateSnapshotScheduler: () => {},
    startRecoveryScheduler: () => {},
    startPersistedQueues: () => {},
    handleSignal: async (signal) => {
      events.push(`handle:${signal}`);
      bot.stop(signal);
    },
    processRef,
    logger: { log: () => {}, warn: () => {} }
  });

  handlers.get("SIGUSR2")();

  await Promise.resolve();
  assert.deepEqual(events, ["launch", "handle:SIGUSR2", "stop:SIGUSR2"]);
});
