import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCodexSessionRuntime } from "../src/codex/session_runtime.js";

async function createFixture(t) {
  const sessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-session-runtime-"));
  t.after(() => fs.rm(sessionsDir, { recursive: true, force: true }));
  const replies = [];
  const activeTurns = new Map();
  const runtime = createCodexSessionRuntime({
    settings: {
      config: { codexSessionsDir: sessionsDir },
      runtimeValue(key) {
        if (key === "codexTransport") return "sdk";
        if (key === "codexWorkerMode") return "inline";
        if (key === "codexAppServerDirectTimeoutMs") return 1000;
        return undefined;
      }
    },
    activeTurns,
    threadCache: new Map(),
    codexClients: new Map(),
    chats: {
      get: () => ({ threadId: "" }),
      getEffectiveOptions: () => ({})
    },
    persistence: { save: async () => {} },
    telegram: { replyHtml: async (_ctx, html) => replies.push(html) }
  });
  return { activeTurns, replies, runtime, sessionsDir };
}

test("session runtime reads and orders nested Codex session metadata", async (t) => {
  const { runtime, sessionsDir } = await createFixture(t);
  const nested = path.join(sessionsDir, "2026", "07");
  await fs.mkdir(nested, { recursive: true });
  const file = path.join(nested, "rollout.jsonl");
  await fs.writeFile(file, `${JSON.stringify({
    type: "session_meta",
    payload: { id: "thread", timestamp: "2026-07-21T00:00:00Z", cwd: "/tmp" }
  })}\n{"type":"event"}\n`);
  assert.equal((await runtime.listRecentCodexSessions(1))[0].id, "thread");
  assert.equal(await runtime.findCodexSessionFile("thread"), file);
});

test("session runtime detects compact status questions", async (t) => {
  const { runtime } = await createFixture(t);
  assert.equal(runtime.isStatusQuestion("어디까지 진행됐어?"), true);
  assert.equal(runtime.isStatusQuestion("Please implement a long unrelated feature request"), false);
});

test("active-turn guard replies once and rejects the action", async (t) => {
  const { activeTurns, replies, runtime } = await createFixture(t);
  activeTurns.set("chat", {});
  assert.equal(await runtime.rejectIfActive({}, "chat"), true);
  assert.equal(replies.length, 1);
  assert.match(replies[0], /\/stop/);
});
