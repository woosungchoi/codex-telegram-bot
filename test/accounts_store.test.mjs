import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createAccountStore, accountHome } from "../src/accounts/store.js";
import { accountConfig, accountThreadId, applyAccountEvent, rememberAccountThread } from "../src/accounts/context.js";
import { reconcileAccountSelections } from "../src/accounts/selection.js";
import { accountFixture } from "./helpers/accounts_fixture.mjs";

test("managed accounts isolate writable state and never snapshot the host credential", async (t) => {
  const { config, store } = await accountFixture(t);
  const account = await store.create("Work");
  const home = accountHome(config, account.id);
  assert.notEqual(home, config.codexHome);
  assert.equal((await fs.stat(home)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(config.codexAccountsDir, "index.json"))).mode & 0o777, 0o600);
  await assert.rejects(fs.stat(path.join(home, "auth.json")), { code: "ENOENT" });
  assert.equal(await fs.readFile(path.join(config.codexHome, "auth.json"), "utf8"), "HOST_TOKEN_SENTINEL");
  assert.doesNotMatch(await fs.readFile(path.join(config.codexAccountsDir, "index.json"), "utf8"), /TOKEN/);
  assert.throws(() => accountHome(config, "../../host"), /Invalid account/);
});

test("independent bot and worker stores serialize updates and protect in-use accounts", async (t) => {
  const { config, store } = await accountFixture(t);
  const other = createAccountStore(config);
  const [a, b] = await Promise.all([store.create("A"), other.create("B")]);
  await Promise.all([store.update(a.id, { status: "ready" }), other.update(b.id, { status: "ready" })]);
  const releaseA = await store.acquire(a.id);
  const releaseB = await other.acquire(a.id);
  await assert.rejects(other.remove(a.id), /running task/);
  await releaseA();
  await assert.rejects(other.remove(a.id), /running task/);
  await releaseB();
  await other.remove(a.id);
  assert.deepEqual((await store.list()).map((x) => x.id), ["default", b.id]);
  const releaseDefault = await store.acquire("default");
  await assert.rejects(store.remove("default"), /running task/);
  await releaseDefault();
  assert.equal(await store.remove("default"), b.id);
  assert.deepEqual((await other.list()).map((x) => x.id), [b.id]);
  assert.equal(await store.defaultAccountId(), b.id);
  await store.setAutoRotate(true);
  assert.deepEqual((await store.candidates()).map((x) => x.id), [b.id]);
  assert.equal(await fs.readFile(path.join(config.codexHome, "auth.json"), "utf8"), "HOST_TOKEN_SENTINEL");
  await assert.rejects(store.remove(b.id), /at least one ready account/);
  await assert.rejects(store.acquire("default"), /needs sign-in/);
});

test("startup reconciles a deleted default account even if the prior state save failed", async (t) => {
  const { store } = await accountFixture(t);
  const account = await store.create("Available");
  await store.update(account.id, { status: "ready" });
  await store.remove("default");
  const state = { chats: { old: { threadId: "host-thread" }, selected: { accountId: "default" } } };
  reconcileAccountSelections(state, await store.list(), await store.defaultAccountId());
  assert.equal(state.accountDefaultId, account.id);
  assert.deepEqual(state.chats.old, { accountId: account.id });
  assert.deepEqual(state.chats.selected, { accountId: account.id });
});

test("default account cannot be removed until another account is ready", async (t) => {
  const { store } = await accountFixture(t);
  const pending = await store.create("Pending");
  await assert.rejects(store.remove("default"), /at least one ready account/);
  assert.deepEqual((await store.list()).map((a) => a.id), ["default", pending.id]);
});

test("corrupt account registry fails closed", async (t) => {
  const { config, store } = await accountFixture(t);
  await store.create("A");
  await fs.writeFile(path.join(config.codexAccountsDir, "index.json"), "bad json");
  await assert.rejects(store.candidates());
});

test("managed SDK environments exclude ambient credentials and preserve execution settings", async (t) => {
  const { config, store } = await accountFixture(t);
  const a = await store.create("A");
  const scoped = accountConfig({ ...config, codexApiKey: "secret", codexEnv: { PATH: "/bin", CODEX_API_KEY: "secret", OPENAI_API_KEY: "secret", CODEX_ACCESS_TOKEN: "secret", CUSTOM: "kept" } }, a.id);
  assert.equal(scoped.codexApiKey, "");
  assert.deepEqual(Object.keys(scoped.codexEnv).sort(), ["CODEX_HOME", "CUSTOM", "PATH"]);
  assert.equal(scoped.codexConfig.cli_auth_credentials_store, "file");
  assert.equal(scoped.codexSessionsDir, path.join(accountHome(config, a.id), "sessions"));
});

test("changing selected account during a turn preserves both thread ownerships", () => {
  const chat = { accountId: "b", threadId: "old", threadAccountId: "default" };
  rememberAccountThread(chat, "running-finished", "default");
  assert.equal(accountThreadId(chat), "");
  applyAccountEvent(chat, { type: "account.selected", fromAccountId: "default", accountId: "c" });
  assert.equal(chat.accountId, "b");
  rememberAccountThread(chat, "b-thread", "b");
  assert.equal(accountThreadId(chat, "default"), "running-finished");
  assert.equal(accountThreadId(chat), "b-thread");
});
