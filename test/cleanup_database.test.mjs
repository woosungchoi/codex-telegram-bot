import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import {
  createCleanupDatabase,
  runCleanupDatabase,
} from "../src/maintenance/cleanup_database.js";
import { createCleanupController } from "../src/maintenance/cleanup_controller.js";
import { fileIdentity } from "../src/fs/anchored.js";
import { createAccountStore, accountHome } from "../src/accounts/store.js";

const exec = promisify(execFile);
const ID = "00000000-0000-0000-0000-000000000001";
const KEEP = "00000000-0000-0000-0000-000000000002";
async function sql(home, database, statements) {
  return exec("python3", [
    "-c",
    "import sqlite3,sys,json\nc=sqlite3.connect(sys.argv[1]);c.executescript(sys.argv[2]);c.close()",
    path.join(home, database),
    statements,
  ]);
}
async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cleanup-database-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const config = {
    codexHome: home,
    codexSessionsDir: path.join(home, "sessions"),
    cleanupQuarantineDir: path.join(home, "quarantine"),
    cleanupArtifactDir: path.join(home, "artifacts"),
    cleanupDatabaseEnabled: true,
  };
  await fs.mkdir(config.codexSessionsDir);
  await fs.mkdir(config.cleanupQuarantineDir);
  const original = path.join(config.codexSessionsDir, "old.jsonl");
  await sql(
    home,
    "state_5.sqlite",
    `CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT,is_pinned INT,updated_at INT);
    CREATE TABLE thread_spawn_edges(parent_thread_id TEXT,child_thread_id TEXT);
    INSERT INTO threads VALUES('${ID}','${original}',0,0),('${KEEP}','${original}-keep',0,0);`,
  );
  await sql(
    home,
    "thread_history_1.sqlite",
    `CREATE TABLE thread_turns(thread_id TEXT,status TEXT);
    CREATE TABLE thread_items(thread_id TEXT,payload TEXT);
    INSERT INTO thread_turns VALUES('${ID}','completed'),('${KEEP}','completed');
    INSERT INTO thread_items VALUES('${ID}','remove'),('${KEEP}','preserve');`,
  );
  const quarantinePath = path.join(config.cleanupQuarantineDir, "old.jsonl");
  const metadata = {
    threadId: ID,
    originalPath: original,
    quarantinedAt: new Date(Date.now() - 10 * 86400000).toISOString(),
    codexHome: home,
  };
  await fs.writeFile(
    quarantinePath,
    JSON.stringify({ type: "session_meta", payload: { id: ID } }) + "\n",
  );
  await fs.writeFile(
    `${quarantinePath}.cleanup.json`,
    JSON.stringify(metadata),
  );
  const candidate = {
    ...metadata,
    path: quarantinePath,
    identity: fileIdentity(await fs.lstat(quarantinePath)),
    bytes: 100,
    quarantineAgeDays: 10,
  };
  const protectedIds = new Set();
  const service = createCleanupDatabase({
    config,
    protectedIds: async () => protectedIds,
  });
  const request = {
    home,
    threadId: ID,
    originalPath: original,
    sessionsRoot: config.codexSessionsDir,
    quarantinePath,
    quarantinedAtMs: Date.parse(metadata.quarantinedAt),
    protectedIds: [],
  };
  return {
    home,
    config,
    original,
    metadata,
    candidate,
    protectedIds,
    service,
    request,
  };
}

test("database preview is read-only; quarantine keeps all rows; delete retires exact ID", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.service.preview([f.candidate])).rows, 3);
  await f.service.prepare(f.candidate, f.metadata);
  assert.equal((await f.service.drain(7)).deferred, 1);
  assert.equal((await f.service.preview([f.candidate])).rows, 3);
  await fs.unlink(f.candidate.path);
  const result = await f.service.drain(7);
  assert.equal(result.deletedRows, 3);
  assert.equal(result.completed, 1);
  assert.deepEqual(result.errors, []);
  assert.equal(await f.service.pendingCount(), 0);
  assert.equal((await f.service.drain(7)).completed, 0);
  const other = {
    ...f.request,
    threadId: KEEP,
    originalPath: `${f.original}-keep`,
    action: "inspect",
  };
  assert.equal((await runCleanupDatabase(other)).rows, 3);
});

test("failed database cleanup retains durable retry and succeeds without the payload", async (t) => {
  const f = await fixture(t);
  await f.service.prepare(f.candidate, f.metadata);
  await fs.unlink(f.candidate.path);
  const failing = createCleanupDatabase({
    config: f.config,
    protectedIds: async () => new Set(),
    run: async () => {
      throw new Error("fixture busy");
    },
  });
  assert.equal((await failing.drain(7)).deferred, 1);
  assert.equal(await f.service.pendingCount(), 1);
  assert.equal((await f.service.drain(7)).deletedRows, 3);
});

for (const protection of [
  "pinned",
  "linked",
  "active",
  "protected",
  "restored",
  "updated",
]) {
  test(`database deletion protects ${protection} sessions`, async (t) => {
    const f = await fixture(t);
    await f.service.prepare(f.candidate, f.metadata);
    await fs.unlink(f.candidate.path);
    if (protection === "pinned")
      await sql(
        f.home,
        "state_5.sqlite",
        `UPDATE threads SET is_pinned=1 WHERE id='${ID}';`,
      );
    if (protection === "linked")
      await sql(
        f.home,
        "state_5.sqlite",
        `INSERT INTO thread_spawn_edges VALUES('${KEEP}','${ID}');`,
      );
    if (protection === "active")
      await sql(
        f.home,
        "thread_history_1.sqlite",
        `UPDATE thread_turns SET status='inProgress' WHERE thread_id='${ID}';`,
      );
    if (protection === "protected") f.protectedIds.add(ID);
    if (protection === "restored") await fs.writeFile(f.original, "restored");
    if (protection === "updated")
      await sql(
        f.home,
        "state_5.sqlite",
        `UPDATE threads SET updated_at=${Math.floor(Date.now() / 1000)} WHERE id='${ID}';`,
      );
    const result = await f.service.drain(7);
    assert.equal(result.deletedRows, 0);
    assert.equal(result.deferred, 1);
    assert.equal(await f.service.pendingCount(), 1);
  });
}

test("unknown database schemas fail closed before payload deletion", async (t) => {
  const f = await fixture(t);
  await sql(
    f.home,
    "state_5.sqlite",
    "CREATE TABLE new_thread_payload(thread_id TEXT);",
  );
  await assert.rejects(
    f.service.prepare(f.candidate, f.metadata),
    /unsupported thread table/,
  );
  assert.equal(await f.service.pendingCount(), 0);
  assert.ok(await fs.stat(f.candidate.path));
});

test("linked databases and unsupported version files are rejected", async (t) => {
  const f = await fixture(t);
  await fs.rename(
    path.join(f.home, "state_5.sqlite"),
    path.join(f.home, "outside.sqlite"),
  );
  await fs.symlink(
    path.join(f.home, "outside.sqlite"),
    path.join(f.home, "state_5.sqlite"),
  );
  await assert.rejects(
    f.service.prepare(f.candidate, f.metadata),
    /not linked/,
  );
  await fs.unlink(path.join(f.home, "state_5.sqlite"));
  await fs.writeFile(path.join(f.home, "state_6.sqlite"), "");
  await assert.rejects(
    f.service.prepare(f.candidate, f.metadata),
    /unsupported Codex database version/,
  );
});

test("metadata cannot redirect deletion to a different thread or account", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.service.prepare(
      { ...f.candidate, threadId: KEEP },
      { ...f.metadata, threadId: KEEP },
    ),
    /ID mismatch/,
  );
  await assert.rejects(
    f.service.inspect({ ...f.candidate, codexHome: path.dirname(f.home) }),
    /account/,
  );
  await assert.rejects(
    f.service.prepare(f.candidate, {
      ...f.metadata,
      originalPath: `${f.original}-keep`,
    }),
    /metadata/,
  );
});

test("restored payload prevents a previously authorized database-only retry", async (t) => {
  const f = await fixture(t);
  await f.service.prepare(f.candidate, f.metadata);
  await fs.rename(f.candidate.path, f.original);
  const result = await f.service.drain(7);
  assert.equal(result.completed, 0);
  assert.match(result.errors[0], /restored or resumed/);
});

function controller(f, candidates) {
  return createCleanupController({
    stateStore: {
      plans: {},
      prunePlans() {},
      async save() {},
      async appendLog() {},
    },
    policy: {
      planTtlHours: () => 24,
      retentionDays: () => 14,
      quarantineDays: () => 7,
      artifactDir: f.config.cleanupArtifactDir,
      sessionsDir: f.config.codexSessionsDir,
      quarantineDir: f.config.cleanupQuarantineDir,
      notifyChatIds: [],
      dateKey: () => "20261015",
    },
    inventory: {
      collectProtectedThreadIds: async () => f.protectedIds,
      listSessionFiles: async () => ({
        candidates: [],
        protectedCount: 0,
        recentCount: 0,
      }),
      listDeleteCandidates: async () => candidates,
      readMaintenanceReport: async () => null,
    },
    telegram: {},
    formatting: {
      text: (k) => k,
      formatText: (k) => k,
      formatBytes: String,
      formatDateTime: String,
      formatCount: String,
      formatResult: () => "",
    },
    database: f.service,
  });
}

test("automatic Cleanup uses the same exact-ID database deletion flow", async (t) => {
  const f = await fixture(t);
  const c = controller(f, [f.candidate]);
  const result = await c.runDailyCleanup("delete");
  assert.equal(result.ok, true);
  assert.equal(result.result.deleted, 1);
  assert.equal(result.result.database.deletedRows, 3);
  await assert.rejects(fs.stat(f.candidate.path), { code: "ENOENT" });
});

test("automatic delete retries journal when no session files remain; quarantine does not", async (t) => {
  const f = await fixture(t);
  await f.service.prepare(f.candidate, f.metadata);
  await fs.unlink(f.candidate.path);
  const c = controller(f, []);
  await c.runDailyCleanup("quarantine");
  assert.equal(await f.service.pendingCount(), 1);
  const result = await c.runDailyCleanup("delete");
  assert.equal(result.ok, true);
  assert.equal(result.result.deleted, 0);
  assert.equal(result.result.database.deletedRows, 3);
});

test("real SQLite writer lock retains retry without deleting rows", async (t) => {
  const f = await fixture(t);
  await f.service.prepare(f.candidate, f.metadata);
  await fs.unlink(f.candidate.path);
  const child = spawn(
    "python3",
    [
      "-u",
      "-c",
      "import sqlite3,sys\nc=sqlite3.connect(sys.argv[1]);c.execute('BEGIN IMMEDIATE');print('ready');sys.stdin.read();c.rollback();c.close()",
      path.join(f.home, "state_5.sqlite"),
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  t.after(() => child.kill());
  await once(child.stdout, "data");
  const blocked = await f.service.drain(7);
  assert.equal(blocked.deletedRows, 0);
  assert.equal(await f.service.pendingCount(), 1);
  assert.match(blocked.errors[0], /locked/);
  const stopped = once(child, "exit");
  child.stdin.end();
  await stopped;
  assert.equal((await f.service.drain(7)).deletedRows, 3);
});

test("compact-only deferred work remains visible and is retried without deleting rows twice", async (t) => {
  const f = await fixture(t);
  await f.service.prepare(f.candidate, f.metadata);
  await fs.unlink(f.candidate.path);
  const service = createCleanupDatabase({
    config: f.config,
    protectedIds: async () => new Set(),
    run: (request) =>
      request.action === "compact"
        ? Promise.resolve({
            ok: true,
            deferred: true,
            databases: [{ reclaimedBytes: 0 }],
          })
        : runCleanupDatabase(request),
  });
  const first = await service.drain(7);
  assert.equal(first.deletedRows, 3);
  assert.equal(first.deferred, 1);
  assert.equal((await f.service.preview([])).pending, 1);
  const retried = await controller(f, []).runDailyCleanup("delete");
  assert.equal(retried.result.database.deletedRows, 0);
  assert.equal(await f.service.pendingCount(), 0);
});

test("managed account deletion leaves identical thread IDs in the default home untouched", async (t) => {
  const f = await fixture(t);
  f.config.codexAccountsDir = path.join(f.home, "accounts");
  const account = await createAccountStore(f.config).create("Fixture");
  const home = accountHome(f.config, account.id);
  const sessionsRoot = path.join(home, "sessions");
  await fs.mkdir(sessionsRoot);
  const originalPath = path.join(sessionsRoot, "old.jsonl");
  await fs.copyFile(
    path.join(f.home, "state_5.sqlite"),
    path.join(home, "state_5.sqlite"),
  );
  await fs.copyFile(
    path.join(f.home, "thread_history_1.sqlite"),
    path.join(home, "thread_history_1.sqlite"),
  );
  await sql(
    home,
    "state_5.sqlite",
    `UPDATE threads SET rollout_path='${originalPath}' WHERE id='${ID}';`,
  );
  const metadata = { ...f.metadata, codexHome: home, originalPath };
  await f.service.prepare({ ...f.candidate, ...metadata }, metadata);
  await fs.unlink(f.candidate.path);
  assert.equal((await f.service.drain(7)).deletedRows, 3);
  assert.equal(
    (await runCleanupDatabase({ ...f.request, action: "inspect" })).rows,
    3,
  );
  assert.equal(
    (
      await runCleanupDatabase({
        ...f.request,
        home,
        sessionsRoot,
        originalPath,
        action: "inspect",
      })
    ).rows,
    0,
  );
});

test("unknown cascading thread relationships and null turn status fail closed", async (t) => {
  const f = await fixture(t);
  await sql(
    f.home,
    "state_5.sqlite",
    "CREATE TABLE extra_payload(owner TEXT REFERENCES threads(id) ON DELETE CASCADE);",
  );
  await assert.rejects(
    f.service.prepare(f.candidate, f.metadata),
    /unsupported thread relationship/,
  );
  await sql(f.home, "state_5.sqlite", "DROP TABLE extra_payload;");
  await sql(
    f.home,
    "thread_history_1.sqlite",
    `UPDATE thread_turns SET status=NULL WHERE thread_id='${ID}';`,
  );
  await assert.rejects(
    f.service.prepare(f.candidate, f.metadata),
    /non-terminal/,
  );
  assert.ok(await fs.stat(f.candidate.path));
});

test("live WAL reader defers compaction until the reader releases its snapshot", async (t) => {
  const f = await fixture(t);
  const child = spawn(
    "python3",
    [
      "-u",
      "-c",
      "import sqlite3,sys\nw=sqlite3.connect(sys.argv[1]);w.execute('PRAGMA journal_mode=WAL');r=sqlite3.connect(sys.argv[1]);r.execute('BEGIN');r.execute('SELECT * FROM thread_items').fetchall();w.execute(\"UPDATE thread_items SET payload='new'\");w.commit();print('ready');sys.stdin.read();r.close();w.close()",
      path.join(f.home, "thread_history_1.sqlite"),
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  t.after(() => child.kill());
  await once(child.stdout, "data");
  assert.equal(
    (await runCleanupDatabase({ home: f.home, action: "compact" })).deferred,
    true,
  );
  const stopped = once(child, "exit");
  child.stdin.end();
  await stopped;
  assert.equal(
    (await runCleanupDatabase({ home: f.home, action: "compact" })).deferred,
    false,
  );
});

test("compaction reclaims free pages while preserving surviving conversation rows", async (t) => {
  const f = await fixture(t);
  await sql(
    f.home,
    "thread_history_1.sqlite",
    `INSERT INTO thread_items VALUES('${ID}',zeroblob(70*1024*1024)); DELETE FROM thread_items WHERE thread_id='${ID}';`,
  );
  const report = await runCleanupDatabase({ home: f.home, action: "compact" });
  assert.equal(report.deferred, false);
  assert.ok(
    report.databases.reduce((n, item) => n + item.reclaimedBytes, 0) >
      64 * 1024 * 1024,
  );
  assert.equal(
    (
      await runCleanupDatabase({
        ...f.request,
        action: "inspect",
        threadId: KEEP,
        originalPath: `${f.original}-keep`,
      })
    ).rows,
    3,
  );
});

test("native trigger bodies are accepted; altered same-name triggers block deletion", async (t) => {
  const f = await fixture(t);
  await sql(
    f.home,
    "state_5.sqlite",
    `ALTER TABLE threads ADD COLUMN updated_at_ms INT;
    CREATE TRIGGER threads_updated_at_ms_after_update
    AFTER UPDATE OF updated_at ON threads
    WHEN NEW.updated_at != OLD.updated_at AND NEW.updated_at_ms IS OLD.updated_at_ms
    BEGIN UPDATE threads SET updated_at_ms = NEW.updated_at * 1000 WHERE id = NEW.id; END;`,
  );
  await sql(
    f.home,
    "thread_history_1.sqlite",
    `CREATE TABLE thread_history_projection_state(thread_id TEXT);
    CREATE TABLE thread_realtime_items(thread_id TEXT);
    CREATE TRIGGER thread_realtime_items_projection_cleanup AFTER DELETE ON thread_history_projection_state
    BEGIN DELETE FROM thread_realtime_items WHERE thread_id = OLD.thread_id; END;
    INSERT INTO thread_history_projection_state VALUES('${ID}'),('${KEEP}');
    INSERT INTO thread_realtime_items VALUES('${ID}'),('${KEEP}');`,
  );
  assert.equal((await f.service.inspect(f.candidate)).rows, 5);
  await sql(
    f.home,
    "thread_history_1.sqlite",
    `DROP TRIGGER thread_realtime_items_projection_cleanup;
    CREATE TRIGGER thread_realtime_items_projection_cleanup AFTER DELETE ON thread_history_projection_state
    BEGIN DELETE FROM thread_realtime_items; END;`,
  );
  await assert.rejects(
    f.service.prepare(f.candidate, f.metadata),
    /unsupported database trigger/,
  );
  await sql(
    f.home,
    "thread_history_1.sqlite",
    `DROP TRIGGER thread_realtime_items_projection_cleanup;
    CREATE TRIGGER thread_realtime_items_projection_cleanup AFTER DELETE ON thread_history_projection_state
    BEGIN DELETE FROM thread_realtime_items WHERE thread_id = OLD.thread_id; END;`,
  );
  await f.service.prepare(f.candidate, f.metadata);
  await fs.unlink(f.candidate.path);
  assert.equal((await f.service.drain(7)).deletedRows, 5);
  assert.equal(
    (
      await runCleanupDatabase({
        ...f.request,
        action: "inspect",
        threadId: KEEP,
        originalPath: `${f.original}-keep`,
      })
    ).rows,
    5,
  );
});
