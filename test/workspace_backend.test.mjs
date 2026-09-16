import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createWorkspaceBackend, readSessionTail } from "../src/workspace/backend.js";
import { accountFixture } from "./helpers/accounts_fixture.mjs";

test("session requests are read-only, paginated and use the chosen account home", async (t) => {
  const { config, store } = await accountFixture(t);
  const account = await store.create("other");
  const calls = []; let closed = 0, seen;
  const backend = createWorkspaceBackend(config, { connect: async (c) => {
    seen = c;
    return { request: async (method, args) => { calls.push({ method, args }); return { data: [], thread: { id: "test" } }; }, close: async () => closed++ };
  } });
  await backend.listSessions(account.id, { cursor: "opaque", query: "needle" });
  assert.match(seen.codexHome, new RegExp(account.id));
  assert.equal(calls[0].args.cursor, "opaque"); assert.equal(calls[0].args.searchTerm, "needle");
  await backend.readSession(account.id, "test");
  assert.deepEqual(calls.map((c) => c.method), ["thread/list", "thread/read"]);
  assert.equal(calls[1].args.includeTurns, false); assert.equal(closed, 2);
});
test("MCP health uses an ephemeral thread, pages status and always closes", async (t) => {
  const { config } = await accountFixture(t);
  const calls = []; let closed = 0;
  const backend = createWorkspaceBackend(config, { connect: async () => ({
    close: async () => closed++, request: async (method, args) => {
      calls.push({ method, args });
      if (method === "config/read") return { config: { mcp_servers: { alpha: { command: "x" }, beta: { enabled: false } } }, layers: [] };
      if (method === "thread/start") return { thread: { id: "probe" } };
      if (method === "mcpServerStatus/list") return { data: [{ name: "alpha", runtimeStatus: "connected", tools: { one: {} } }], nextCursor: null };
      return {};
    }
  }) });
  const result = await backend.readMcp("default", config.codexHome, true);
  assert.equal(result.rows[0].tools, 1); assert.equal(result.rows[1].status, "disabled");
  assert.equal(calls.find((v) => v.method === "thread/start").args.ephemeral, true);
  assert.equal(calls.at(-1).method, "thread/unsubscribe"); assert.equal(closed, 1);
  assert.ok(!calls.some((v) => v.method === "turn/start"));
});
test("MCP writes quote names and carry config concurrency version; overrides are reported", async (t) => {
  const { config } = await accountFixture(t);
  const calls = [];
  const backend = createWorkspaceBackend(config, { connect: async () => ({
    close: async () => {}, request: async (method, args) => {
      calls.push({ method, args });
      if (method === "config/read") return { config: { mcp_servers: { "a.b": { enabled: true } } } };
      return { status: "okOverridden" };
    }
  }) });
  await assert.rejects(backend.setMcpEnabled("default", config.codexHome, "a.b", false, "revision-1"), /overrides/);
  const write = calls.find((v) => v.method === "config/value/write");
  assert.equal(write.args.keyPath, 'mcp_servers."a.b".enabled');
  assert.equal(write.args.expectedVersion, "revision-1");
  assert.equal(write.args.filePath, path.join(config.codexHome, "config.toml"));
});
test("session preview excludes image bytes, hidden reasoning and raw tool output", async (t) => {
  const { root } = await accountFixture(t);
  const file = path.join(root, "session.jsonl");
  const record = (p) => JSON.stringify({ type: "response_item", payload: p });
  await fs.writeFile(file, [
    record({ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }, { type: "input_image", image_url: "SECRET_IMAGE" }] }),
    record({ type: "message", role: "assistant", channel: "analysis", content: [{ type: "output_text", text: "SECRET_REASONING" }] }),
    record({ type: "function_call_output", output: "SECRET_TOOL" }),
    JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }),
    record({ type: "message", role: "assistant", channel: "final", content: [{ type: "output_text", text: "done" }] })
  ].join("\n"));
  const result = await readSessionTail(file, root);
  assert.deepEqual(result.messages.map((v) => v.text), ["hello", "done"]); assert.equal(result.activity, "running");
  await assert.rejects(readSessionTail(file, path.join(root, "host")), /outside/);
});
