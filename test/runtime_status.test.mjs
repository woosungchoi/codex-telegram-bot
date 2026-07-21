import test from "node:test";
import assert from "node:assert/strict";
import { createRuntimeStatusSupport } from "../src/status/runtime_status.js";

function createFixture() {
  const files = new Map();
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
    readFile: async (file) => files.get(file),
    now: () => new Date("2026-07-21T03:04:00.000Z")
  });
  return { support, files };
}

test("runtime status formats deterministic local clock and byte values", () => {
  const { support } = createFixture();
  assert.deepEqual(support.getLocalClock(), { dateKey: "2026-07-21", time: "03:04" });
  assert.equal(support.getLocalDateKey(), "2026-07-21");
  assert.equal(support.formatBytes(1536), "1.5 KB");
  assert.equal(support.formatBytes(2 * 1024 * 1024), "2 MB");
});

test("runtime status reads the latest valid token-count event", async () => {
  const { support, files } = createFixture();
  files.set("thread", [
    "not-json",
    JSON.stringify({ timestamp: "2026-07-21T00:00:00Z", payload: { type: "token_count", input_tokens: 1 } }),
    JSON.stringify({ timestamp: "2026-07-21T00:01:00Z", payload: { type: "token_count", input_tokens: 2 } })
  ].join("\n"));

  const sample = await support.readLatestTokenCount("thread");
  assert.equal(sample.tokenCount.input_tokens, 2);
  assert.equal(sample.sampledAt, "2026-07-21T00:01:00Z");
});

test("runtime config summary exposes only whether sensitive config is set", () => {
  const { support } = createFixture();
  const summary = support.buildConfigSummary();
  assert.equal(summary.codexApiKey, "set");
  assert.equal(summary.codexConfig, "set");
  assert.equal(summary.codexEnv, "set");
  assert.equal(summary.telegramLiveProgressIntervalSeconds, 3);
});
