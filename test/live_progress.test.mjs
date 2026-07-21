import test from "node:test";
import assert from "node:assert/strict";
import { createLiveProgressController } from "../src/ui/live_progress.js";

function createFixture({ enabled = true, source = "both" } = {}) {
  const sent = [];
  const controller = createLiveProgressController({
    settings: {
      runtimeValue(key) {
        if (key === "telegramLiveProgressMode") return "brief";
        if (key === "telegramLiveProgressIntervalMs") return 0;
        if (key === "telegramFormatCodexAnswers") return "safe";
        if (key === "maxTelegramChars") return 4096;
        return 0;
      }
    },
    options: {
      get: () => ({ liveProgressEnabled: enabled, liveProgressSource: source }),
      defaults: () => ({ liveProgressDeletePolicy: "always" })
    },
    telegram: {
      getChatKey: () => "chat",
      replyTracked: async (_ctx, _state, html) => { sent.push(html); }
    },
    recovery: { recordProgressFailed: async () => {} },
    localization: {
      language: () => "en",
      forLanguage: (_language, key) => key,
      formatForLanguage: (_language, key, values) => `${key}:${Object.values(values).join(",")}`
    },
    formatting: {
      redact: (value) => value,
      truncate: (value, max) => String(value ?? "").slice(0, max)
    },
    now: () => 1000
  });
  return { controller, sent };
}

test("live progress combines agent and activity views and suppresses duplicates", async () => {
  const { controller, sent } = createFixture();
  const state = controller.createLiveProgressState({});
  state.chatKey = "chat";
  const event = {
    type: "item.completed",
    item: { id: "message", type: "agent_message", text: "Working" }
  };

  assert.equal(await controller.maybeSendLiveProgress({}, state, event, [event.item]), true);
  assert.equal(await controller.maybeSendLiveProgress({}, state, event, [event.item]), false);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Working/);
});

test("live progress respects disabled options and deletion policy", async () => {
  const { controller, sent } = createFixture({ enabled: false });
  const state = controller.createLiveProgressState();
  assert.equal(await controller.maybeSendLiveProgress({}, state, { type: "turn.started" }, []), false);
  assert.equal(sent.length, 0);
  assert.equal(controller.shouldDeleteLiveProgress(state, false), true);
});

test("progress summary and final response formatting stay deterministic", () => {
  const { controller } = createFixture();
  assert.equal(controller.formatTurn({ finalResponse: "  done  " }), "done");
  assert.equal(controller.summarizeProgress([
    { type: "reasoning" },
    { type: "command_execution", command: "npm test" }
  ]), "Codex progress\nreasoning:1\ncmd:1\nlast: npm test");
});
