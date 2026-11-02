import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectAppServer } from "../src/codex/app_server.js";
import { createCodexThread, buildCodexClientOptions } from "../src/codex/thread_factory.js";
import { accountConfig } from "../src/accounts/context.js";
import { inspectAccount } from "../src/accounts/auth.js";
import { readConfig } from "../src/config.js";

async function server(t, { requireFile = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "mcp-store-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const script = join(dir, "server.mjs");
  const log = join(dir, "calls.jsonl");
  await writeFile(log, "");
  await writeFile(script, `#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
const send = x => process.stdout.write(JSON.stringify(x) + '\\n');
createInterface({ input: process.stdin }).on('line', line => {
  const x = JSON.parse(line);
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ method: x.method, params: x.params, args }) + '\\n');
  // Reproduce a keyring stall before a session override can arrive.
  if (${requireFile} && !args.includes('mcp_oauth_credentials_store="file"')) return;
  if (x.method === 'initialize') send({ id: x.id, result: {} });
  if (['thread/start', 'thread/resume'].includes(x.method))
    send({ id: x.id, result: { thread: { id: x.params.threadId || 'new-thread' } } });
  if (x.method === 'turn/start') send({ id: x.id, result: { turn: { id: 'turn', status: 'completed', items: [] } } });
  if (x.method === 'account/read') send({ id: x.id, result: { account: { type: 'chatgpt', planType: 'pro' } } });
  if (x.method === 'account/rateLimits/read') send({ id: x.id, result: {} });
});`, { mode: 0o700 });
  return { script, calls: async () => (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse) };
}

function config(script, value) {
  return readConfig({ HOME: "/home/tester", TELEGRAM_BOT_TOKEN: "123:token", ALLOWED_USER_IDS: "42",
    CODEX_PATH: script, CODEX_CONFIG_JSON: JSON.stringify(value) }, { appRoot: "/app", cwd: "/repo" });
}

for (const store of [undefined, "file", "auto", "keyring"]) {
  test(`app-server preserves explicit MCP storage choice ${store ?? "native default"}`, async (t) => {
    const { script, calls } = await server(t);
    const scoped = accountConfig(config(script, { mcp_oauth_credentials_store: store, unrelated_secret: "not-forwarded" }), "default");
    const client = await connectAppServer(scoped);
    await client.close();
    const args = (await calls())[0].args;
    assert.deepEqual(args.filter(x => x.startsWith("mcp_oauth_credentials_store=")),
      store ? [`mcp_oauth_credentials_store="${store}"`] : []);
    assert.equal(args.some(x => x.includes("not-forwarded")), false);
    assert.equal(buildCodexClientOptions(scoped).config.mcp_oauth_credentials_store, store);
  });
}

for (const threadId of ["", "existing-thread"]) {
  test(`MCP file storage avoids startup stall for ${threadId ? "resume" : "new thread"}`, async (t) => {
    const { script, calls } = await server(t, { requireFile: true });
    t.mock.method(console, "warn", () => {});
    const scoped = accountConfig(config(script, { mcp_oauth_credentials_store: "file" }), "11111111-1111-4111-8111-111111111111");
    assert.equal(buildCodexClientOptions(scoped).config.mcp_oauth_credentials_store, "file");
    const thread = createCodexThread({ transport: "app-server-direct", threadId, config: scoped });
    thread.connectTimeoutMs = 3000;
    thread.sessionTimeoutMs = 500;
    await thread.run("hello");
    const requests = await calls();
    assert.equal(requests.filter(x => x.method === "turn/start").length, 1);
    assert.equal(requests.filter(x => x.method === "initialize").length, 1);
    assert.ok(requests.every(x => x.args.includes('mcp_oauth_credentials_store="file"')));
    assert.equal(thread.id, threadId || "new-thread");
  });
}

test("managed account queries receive the MCP store independently of CLI login storage", async (t) => {
  const { script, calls } = await server(t, { requireFile: true });
  const result = await inspectAccount(config(script, { mcp_oauth_credentials_store: "file" }), "11111111-1111-4111-8111-111111111111");
  assert.equal(result.status, "ready");
  assert.ok((await calls()).every(x => x.args.includes('cli_auth_credentials_store="file"')
    && x.args.includes('mcp_oauth_credentials_store="file"')));
});

test("invalid MCP storage is rejected before spawning without echoing its value", async () => {
  for (const value of ["private-invalid-value", null, {}, true]) {
    await assert.rejects(connectAppServer({ codexPath: "/does-not-exist", codexConfig: { mcp_oauth_credentials_store: value } }),
      error => error.message === "mcp_oauth_credentials_store must be auto, file, or keyring.");
  }
});
