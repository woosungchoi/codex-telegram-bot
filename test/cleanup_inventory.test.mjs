import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCleanupInventory } from "../src/maintenance/cleanup_inventory.js";

test("database Cleanup stops when active Codex processes cannot be inspected", async () => {
  const inventory = createCleanupInventory({
    settings: { config: { cleanupDatabaseEnabled: true } },
    state: { chats: {} }, threadCache: new Map(), sessions: {},
    runProcess: async () => { throw new Error("process listing unavailable"); },
    now: () => new Date()
  });
  await assert.rejects(inventory.collectProtectedThreadIds(), /process listing unavailable/);
});

test("cleanup inventory ignores a quarantined file removed during scanning", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cleanup-inventory-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const present = path.join(root, "present.jsonl");
  await fs.writeFile(present, "session\n");
  const inventory = createCleanupInventory({
    settings: {
      config: { cleanupQuarantineDir: root },
      runtimeValue: () => 1
    },
    state: { chats: {} },
    threadCache: new Map(),
    sessions: {
      listFiles: async () => [path.join(root, "missing.jsonl"), present],
      readMeta: async () => ({ id: "present" })
    },
    now: () => new Date("2026-09-29T00:00:00Z")
  });
  await fs.utimes(present, new Date("2026-09-01T00:00:00Z"), new Date("2026-09-01T00:00:00Z"));

  const candidates = await inventory.listQuarantineDeleteCandidates();

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].path, present);
});

test("cleanup inventory ignores a session removed after metadata inspection", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cleanup-inventory-session-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const session = path.join(root, "session.jsonl");
  await fs.writeFile(session, "session\n");
  const inventory = createCleanupInventory({
    settings: {
      config: { codexSessionsDir: root },
      runtimeValue: () => 1
    },
    state: { chats: {} },
    threadCache: new Map(),
    sessions: {
      listFiles: async () => [session],
      readMeta: async () => {
        await fs.rm(session);
        return { id: "session" };
      }
    },
    now: () => new Date("2026-09-29T00:00:00Z")
  });

  const scan = await inventory.listCleanupSessionFiles(new Set());

  assert.deepEqual(scan.candidates, []);
  assert.equal(scan.recentCount, 0);
});
