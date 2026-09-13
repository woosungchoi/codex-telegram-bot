import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  migrateRuntimeState,
  normalizeWorkspaceState,
} from "../src/state/schema.js";
import {
  loadRuntimeState,
  saveRuntimeState,
} from "../src/runtime/state_store.js";

const options = {
  defaults: {
    telegramLanguage: "en",
    telegramTimeZone: "UTC",
    telegramLocale: "en-US",
  },
  parseLanguage: String,
  parseTimeZone: String,
  parseLocale: String,
  readFile: fs.readFile,
  now: 1000,
};
function legacyState() {
  return {
    chats: { one: { accountId: "work", threadId: "thread" } },
    queues: { one: [{ id: "queued" }] },
    workspace: {
      projects: { owner: [{ id: "p", name: "Project", cwd: "/workspace" }] },
      tasks: { t: { id: "t", run: { workerJobId: "job", status: "running" } } },
      flows: {
        old: { expiresAt: 500 },
        live: {
          expiresAt: 2000,
          token: "keep",
          actions: [{ type: "projects" }],
        },
      },
      panels: { one: { messageId: 3 } },
      panelPreferences: { one: false },
      extension: { retained: true },
    },
    forum: {
      groups: { group: { topics: { 1: { bindingId: "binding" } } } },
      jobs: { job: { state: "running" } },
    },
    accountUi: { old: { expiresAt: 500 }, live: { expiresAt: 2000 } },
    accountResetAttempts: {
      work: {
        requestId: "uncertain-request",
        expiresAt: 100,
        status: "pending",
      },
    },
    worker: {
      deliveries: { job: { state: "uncertain", messageId: 99 } },
      extension: "keep",
    },
    futureExtension: { retained: true },
  };
}

test("legacy state migrates once and survives an atomic save/reload with recovery records intact", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "state-migration-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "state.json");
  const original = legacyState();
  await fs.writeFile(file, JSON.stringify(original));
  const loaded = await loadRuntimeState(file, options);
  assert.equal(loaded.schemaVersion, 1);
  assert.equal(loaded.workspace.version, 1);
  assert.equal(loaded.forum.version, 1);
  for (const key of [
    "chats",
    "queues",
    "accountResetAttempts",
    "worker",
    "futureExtension",
  ])
    assert.deepEqual(loaded[key], original[key]);
  for (const key of [
    "projects",
    "tasks",
    "panels",
    "panelPreferences",
    "extension",
  ])
    assert.deepEqual(loaded.workspace[key], original.workspace[key]);
  assert.deepEqual(loaded.forum.jobs, original.forum.jobs);
  assert.deepEqual(loaded.forum.groups, original.forum.groups);
  assert.deepEqual(Object.keys(loaded.accountUi), ["live"]);
  assert.deepEqual(Object.keys(loaded.workspace.flows), ["live"]);
  assert.deepEqual(loaded.workspace.flows.live, original.workspace.flows.live);
  await saveRuntimeState(file, loaded);
  assert.deepEqual(await loadRuntimeState(file, options), loaded);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
});

test("migration preserves its input and normalized namespaces keep live references", () => {
  const input = legacyState(),
    copy = globalThis.structuredClone(input);
  const migrated = migrateRuntimeState(input, { now: 1000 });
  assert.deepEqual(input, copy);
  assert.deepEqual(migrateRuntimeState(migrated, { now: 1000 }), migrated);
  assert.equal(normalizeWorkspaceState(migrated.workspace), migrated.workspace);
});

test("future versions and malformed containers fail without overwriting the saved file", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "state-invalid-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "state.json");
  for (const invalid of [
    null,
    [],
    { schemaVersion: 2 },
    { workspace: { version: 2 } },
    { forum: { version: 2 } },
    { workspace: { projects: { owner: {} } } },
    { workspace: { tasks: [] } },
    { forum: { groups: [] } },
    { accountResetAttempts: { account: null } },
    { chats: [] },
  ]) {
    const bytes = JSON.stringify(invalid);
    await fs.writeFile(file, bytes);
    await assert.rejects(loadRuntimeState(file, options), /saved state/);
    assert.equal(await fs.readFile(file, "utf8"), bytes);
  }
});
