import test from "node:test";
import assert from "node:assert/strict";
import { createRuntimeStatusSupport } from "../src/status/runtime_status.js";

function createFixture() {
  const files = new Map();
  const reads = [];
  let closes = 0;
  const support = createRuntimeStatusSupport({
    settings: {
      config: {
        telegramLiveProgressIntervalMs: 2000,
        codexApiKey: "secret",
        codexConfig: {},
        codexEnv: {},
        codexCompactStrength: "default"
      },
      runtimeValue: (key) => key === "telegramLiveProgressIntervalMs" ? 3000 : undefined,
      packageFile: "/app/package.json"
    },
    chats: { get: () => ({}) },
    packages: {
      readJson: async () => ({ version: "1.2.8" }),
      readPackage: async () => ({ version: "0.1.0" })
    },
    sessions: { findFile: async (threadId) => files.has(threadId) ? threadId : null },
    localization: { locale: () => "en-US", timeZone: () => "UTC" },
    formatting: { redactValue: (value) => value },
    openSessionFile: async (file) => {
      const content = Buffer.from(files.get(file));
      return {
        stat: async () => ({ size: content.length }),
        read: async (target, offset, length, position) => {
          const bytesRead = Math.max(0, Math.min(length, content.length - position));
          content.copy(target, offset, position, position + bytesRead);
          reads.push({ bytesRead, length, position });
          return { bytesRead, buffer: target };
        },
        close: async () => {
          closes += 1;
        }
      };
    },
    now: () => new Date("2026-07-21T03:04:00.000Z")
  });
  return { support, files, reads, closes: () => closes };
}

test("runtime status formats deterministic local clock and byte values", () => {
  const { support } = createFixture();
  assert.deepEqual(support.getLocalClock(), { dateKey: "2026-07-21", time: "03:04" });
  assert.equal(support.getLocalDateKey(), "2026-07-21");
  assert.equal(support.formatBytes(1536), "1.5 KB");
  assert.equal(support.formatBytes(2 * 1024 * 1024), "2 MB");
});

test("runtime status reads the latest valid token-count event", async () => {
  const { support, files, closes } = createFixture();
  files.set("thread", [
    "not-json",
    JSON.stringify({ timestamp: "2026-07-21T00:00:00Z", payload: { type: "token_count", input_tokens: 1 } }),
    JSON.stringify({ timestamp: "2026-07-21T00:01:00Z", payload: { type: "token_count", input_tokens: 2 } })
  ].join("\n"));

  const sample = await support.readLatestTokenCount("thread");
  assert.equal(sample.tokenCount.input_tokens, 2);
  assert.equal(sample.sampledAt, "2026-07-21T00:01:00Z");
  assert.equal(closes(), 1);
});

test("runtime status reads only a bounded tail when the latest token count is near EOF", async () => {
  const { support, files, reads } = createFixture();
  files.set("thread", [
    JSON.stringify({ payload: { type: "custom_tool_call_output", output: "x".repeat(2 * 1024 * 1024) } }),
    JSON.stringify({ timestamp: "2026-07-21T00:02:00Z", payload: { type: "token_count", input_tokens: 3 } })
  ].join("\n"));

  const sample = await support.readLatestTokenCount("thread");
  assert.equal(sample.tokenCount.input_tokens, 3);
  assert.equal(reads.length, 1);
  assert.ok(reads[0].position > 0);
  assert.ok(reads[0].length <= 64 * 1024);
});

test("runtime status skips oversized image records while scanning backward", async () => {
  const { support, files, reads } = createFixture();
  files.set("thread", [
    JSON.stringify({ timestamp: "2026-07-21T00:03:00Z", payload: { type: "token_count", input_tokens: 4 } }),
    JSON.stringify({ payload: { type: "custom_tool_call_output", output: "x".repeat(2 * 1024 * 1024) } }),
    JSON.stringify({ timestamp: "2026-07-21T00:04:00Z", payload: { type: "error" } })
  ].join("\n"));

  const sample = await support.readLatestTokenCount("thread");
  assert.equal(sample.tokenCount.input_tokens, 4);
  assert.ok(reads.length > 1);
  assert.ok(reads.every(({ length }) => length <= 64 * 1024));
});

test("runtime config summary exposes only whether sensitive config is set", () => {
  const { support } = createFixture();
  const summary = support.buildConfigSummary();
  assert.equal(summary.codexApiKey, "set");
  assert.equal(summary.codexConfig, "set");
  assert.equal(summary.codexEnv, "set");
  assert.equal(summary.telegramLiveProgressIntervalSeconds, 3);
});
