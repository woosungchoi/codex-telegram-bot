import test from "node:test";
import assert from "node:assert/strict";
import {
  applyModelSelectionDraft,
  applyReasoningSelection,
  createSelectionFlowStore
} from "../src/ui/model_selection_flow.js";

test("selection flow store advances one chat-bound draft and supersedes older flows", () => {
  const tokens = ["aaaaaa", "bbbbbb", "cccccc"];
  const store = createSelectionFlowStore({
    tokenFactory: () => tokens.shift(),
    now: () => 1_000
  });

  const first = store.begin("chat:topic", "model");
  assert.deepEqual(first, {
    token: "aaaaaa",
    chatKey: "chat:topic",
    kind: "model",
    phase: "model",
    modelChoice: "",
    modelSlug: "",
    reasoningChoice: "",
    fastSupported: false,
    createdAt: 1_000,
    updatedAt: 1_000
  });
  assert.equal(store.update("other-chat", first.token, "model", { phase: "reasoning" }), null);
  assert.equal(store.update("chat:topic", first.token, "reasoning", { phase: "fast" }), null);

  const reasoning = store.update("chat:topic", first.token, "model", {
    phase: "reasoning",
    modelChoice: "gpt-5.6-sol",
    modelSlug: "gpt-5.6-sol",
    fastSupported: true
  });
  assert.equal(reasoning.phase, "reasoning");
  assert.equal(reasoning.modelSlug, "gpt-5.6-sol");

  const replacement = store.begin("chat:topic", "reasoning", { modelSlug: "gpt-5.6-luna" });
  assert.equal(replacement.token, "bbbbbb");
  assert.equal(replacement.phase, "reasoning");
  assert.equal(store.read("chat:topic", first.token), null);
  assert.equal(store.read("chat:topic", replacement.token).modelSlug, "gpt-5.6-luna");

  const finished = store.finish("chat:topic", replacement.token, "reasoning");
  assert.equal(finished.token, replacement.token);
  assert.equal(store.read("chat:topic", replacement.token), null);
  assert.equal(store.finish("chat:topic", replacement.token, "reasoning"), null);
});

test("selection flow store expires drafts and default tokens fit callback limits", () => {
  let currentTime = 5_000;
  const expiring = createSelectionFlowStore({ now: () => currentTime, maxAgeMs: 100 });
  const session = expiring.begin("chat", "model");
  assert.match(session.token, /^[a-f0-9]{6}$/);
  assert.ok(Buffer.byteLength(`m:${session.token}:${"m".repeat(54)}`, "utf8") <= 64);
  assert.ok(Buffer.byteLength(`r:${session.token}:${"e".repeat(50)}`, "utf8") <= 64);

  currentTime = 5_101;
  assert.equal(expiring.read("chat", session.token), null);
  assert.equal(expiring.size(), 0);
});

test("phase claims reject duplicate callbacks without discarding the active flow", () => {
  const store = createSelectionFlowStore({
    tokenFactory: () => "abcdef",
    now: () => 10
  });
  const session = store.begin("chat", "model");
  const claimed = store.update("chat", session.token, "model", { phase: "model_processing" });
  assert.equal(claimed.phase, "model_processing");
  assert.equal(store.update("chat", session.token, "model", { phase: "reasoning" }), null);
  assert.equal(store.read("chat", session.token).phase, "model_processing");
  assert.equal(store.finish("chat", session.token, "committing"), null);
  assert.equal(store.read("chat", session.token).phase, "model_processing");
});

test("completed model selection applies model, reasoning, and compatible Fast atomically", () => {
  const original = {
    sandboxMode: "workspace-write",
    model: "old-model",
    modelReasoningEffort: "high",
    serviceTier: "flex"
  };
  const updated = applyModelSelectionDraft(original, {
    modelChoice: "gpt-5.6-sol",
    reasoningChoice: "ultra",
    fastSupported: true,
    fastChoice: "on"
  });

  assert.deepEqual(updated, {
    sandboxMode: "workspace-write",
    model: "gpt-5.6-sol",
    modelReasoningEffort: "ultra",
    serviceTier: "fast"
  });
  assert.deepEqual(original, {
    sandboxMode: "workspace-write",
    model: "old-model",
    modelReasoningEffort: "high",
    serviceTier: "flex"
  });
});

test("default choices remove overrides and non-Fast models clear only a stale Fast tier", () => {
  assert.deepEqual(
    applyModelSelectionDraft(
      {
        model: "old-model",
        modelReasoningEffort: "high",
        serviceTier: "fast",
        approvalPolicy: "never"
      },
      {
        modelChoice: "default",
        reasoningChoice: "default",
        fastSupported: false,
        fastChoice: ""
      }
    ),
    { approvalPolicy: "never" }
  );

  assert.deepEqual(
    applyModelSelectionDraft(
      { serviceTier: "flex", networkAccessEnabled: true },
      {
        modelChoice: "gpt-5.4-mini",
        reasoningChoice: "medium",
        fastSupported: false,
        fastChoice: ""
      }
    ),
    {
      model: "gpt-5.4-mini",
      modelReasoningEffort: "medium",
      serviceTier: "flex",
      networkAccessEnabled: true
    }
  );
});

test("standalone reasoning selection changes only the explicit reasoning override", () => {
  const original = { model: "gpt-5.6-sol", serviceTier: "fast", modelReasoningEffort: "high" };
  assert.deepEqual(applyReasoningSelection(original, "default"), {
    model: "gpt-5.6-sol",
    serviceTier: "fast"
  });
  assert.deepEqual(applyReasoningSelection(original, "ultra"), {
    model: "gpt-5.6-sol",
    serviceTier: "fast",
    modelReasoningEffort: "ultra"
  });
  assert.equal(original.modelReasoningEffort, "high");
});
