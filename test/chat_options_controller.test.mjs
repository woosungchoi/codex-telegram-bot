import test from "node:test";
import assert from "node:assert/strict";
import { createChatOptionsController } from "../src/codex/chat_options_controller.js";

function createHarness() {
  const state = { chats: {} };
  const threadCache = new Map();
  const ensured = [];
  const replies = [];
  const controller = createChatOptionsController({
    settings: {
      workingDirectory: "/workspace",
      skipGitRepoCheck: true,
      approvalPolicy: "on-request",
      sandboxMode: "workspace-write",
      reasoningEffort: "high",
      webSearchMode: "cached",
      liveProgressEnabled: () => true,
      liveProgressSource: "agent",
      liveProgressDeletePolicy: "on_success",
      model: "gpt-test",
      networkAccessEnabled: false,
      webSearchEnabled: true,
      additionalDirectories: ["/shared", "/uploads"],
      uploadDir: "/uploads"
    },
    stateStore: { chats: state.chats, save: async () => {} },
    threadCache,
    models: { list: async () => [] },
    telegram: {
      commandName: () => "option",
      formatOptionsHtml: () => "options",
      getChatKey: () => "chat",
      getCommandArgs: () => "",
      rejectIfActive: async () => false,
      replyHtml: async (_ctx, html) => replies.push(html)
    },
    validation: {
      ensureDirectory: async (...args) => ensured.push(args),
      parseRequiredBoolean: (value, label) => {
        if (["on", "true"].includes(value)) return true;
        if (["off", "false"].includes(value)) return false;
        throw new Error(`${label} must be on or off.`);
      },
      validApprovalPolicies: new Set(["never", "on-request"]),
      validLiveProgressDeletePolicies: new Set(["always", "on_success", "never"]),
      validLiveProgressSources: new Set(["agent", "activity", "both"]),
      validSandboxModes: new Set(["read-only", "workspace-write"]),
      validServiceTiers: new Set(["fast", "flex"]),
      validWebSearchModes: new Set(["disabled", "cached", "live"])
    },
    text: (key) => key,
    now: () => new Date("2026-07-21T06:07:08.000Z")
  });
  return { controller, ensured, replies, state, threadCache };
}

test("chat options merge configured defaults and initialize chat state deterministically", () => {
  const { controller, state } = createHarness();

  assert.deepEqual(controller.defaultChatOptions(), {
    workingDirectory: "/workspace",
    skipGitRepoCheck: true,
    approvalPolicy: "on-request",
    sandboxMode: "workspace-write",
    modelReasoningEffort: "high",
    webSearchMode: "cached",
    streamEvents: true,
    liveProgressEnabled: true,
    liveProgressSource: "agent",
    liveProgressDeletePolicy: "on_success",
    model: "gpt-test",
    networkAccessEnabled: false,
    webSearchEnabled: true,
    additionalDirectories: ["/shared", "/uploads"]
  });
  assert.deepEqual(controller.getChatState("chat"), {
    options: {},
    updatedAt: "2026-07-21T06:07:08.000Z"
  });
  state.chats.chat.outputSchema = { type: "object" };
  const signal = new AbortController().signal;
  assert.deepEqual(controller.buildTurnOptions("chat", signal), {
    signal,
    outputSchema: { type: "object" }
  });
  assert.equal(controller.effectiveModelSlug("chat"), "gpt-test");
  assert.equal(controller.getEffectiveOptions("chat").outputSchema, undefined);
});

test("chat option mutation validates values and invalidates cached threads", async () => {
  const { controller, ensured, state, threadCache } = createHarness();
  controller.getChatState("chat");
  threadCache.set("chat", { id: "cached" });

  await controller.setOption("chat", "workingDirectory", "/next");
  assert.deepEqual(ensured, [["/next", "working directory"]]);
  assert.equal(state.chats.chat.options.workingDirectory, "/next");
  assert.equal(threadCache.has("chat"), false);

  await controller.setOption("chat", "liveProgressEnabled", "false");
  assert.equal(state.chats.chat.options.liveProgressEnabled, false);
  await assert.rejects(
    () => controller.setOption("chat", "sandboxMode", "danger-full-access"),
    /sandbox must be one of/
  );
  assert.equal(state.chats.chat.options.sandboxMode, undefined);
});

test("chat option commands report usage without mutating state", async () => {
  const { controller, replies, state } = createHarness();

  await controller.updateOptionCommand({}, "sandboxMode", "mode");

  assert.deepEqual(state.chats, {});
  assert.match(replies[0], /Usage: <code>\/option &lt;mode&gt;<\/code>/);
});
