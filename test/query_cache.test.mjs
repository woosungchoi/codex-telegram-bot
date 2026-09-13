import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createQueryCache } from "../src/utils/query_cache.js";
import { createAccountUsageReader } from "../src/accounts/usage.js";
import { createWorkspaceBackend } from "../src/workspace/backend.js";
import { accountFixture } from "./helpers/accounts_fixture.mjs";

test("query cache deduplicates, isolates mutable results, expires and forces refresh", async () => {
  let time = 0,
    reads = 0;
  const cache = createQueryCache({ ttlMs: 10, now: () => time });
  const load = async () => ({ value: ++reads });
  const [a, b] = await Promise.all([
    cache.get("a", load),
    cache.get("a", load),
  ]);
  a.value = 100;
  assert.equal(b.value, 1);
  assert.equal(reads, 1);
  assert.equal((await cache.get("a", load)).value, 1);
  time = 11;
  assert.equal((await cache.get("a", load)).value, 2);
  assert.equal((await cache.get("a", load, { fresh: true })).value, 3);
});

test("failed or invalidated in-flight queries cannot poison the cache", async () => {
  const cache = createQueryCache();
  await assert.rejects(
    cache.get("a", async () => {
      throw new Error("offline");
    }),
    /offline/,
  );
  let resolve;
  const old = cache.get(
    "a",
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  await Promise.resolve();
  cache.clear();
  assert.equal(await cache.get("a", async () => "new"), "new");
  resolve("old");
  assert.equal(await old, "old");
  assert.equal(await cache.get("a", async () => "bad"), "new");
});

test("account usage never shares accounts and notices replaced authentication", async (t) => {
  const { config, store } = await accountFixture(t);
  const other = await store.create("Other");
  let calls = 0;
  const reader = createAccountUsageReader(config, {
    read: async (_c, id) => ({ id, calls: ++calls }),
  });
  await Promise.all([reader.read("default"), reader.read("default")]);
  assert.equal(calls, 1);
  assert.equal((await reader.read(other.id)).id, other.id);
  assert.equal(calls, 2);
  await fs.writeFile(path.join(config.codexHome, "auth.json"), "{}");
  await reader.read("default");
  assert.equal(calls, 3);
  await reader.read("default", { fresh: true });
  assert.equal(calls, 4);
  reader.invalidate();
  await reader.read("default");
  assert.equal(calls, 5);
});

test("session queries deduplicate per account/filter and refresh explicitly", async (t) => {
  const { config, store } = await accountFixture(t);
  const other = await store.create("Other");
  let opened = 0,
    closed = 0;
  const backend = createWorkspaceBackend(config, {
    connect: async () => {
      opened++;
      return {
        request: async () => ({ data: [], thread: { id: "t" } }),
        close: async () => closed++,
      };
    },
  });
  await Promise.all([
    backend.listSessions("default"),
    backend.listSessions("default"),
  ]);
  assert.equal(opened, 1);
  await backend.listSessions(other.id);
  await backend.listSessions("default", { cwd: "/other" });
  await backend.listSessions("default", { fresh: true });
  assert.equal(opened, 4);
  await backend.readSession("default", "t");
  await backend.readSession("default", "t");
  assert.equal(opened, 5);
  await backend.readSession("default", "t", { fresh: true });
  assert.equal(opened, 6);
  assert.equal(closed, opened);
});
