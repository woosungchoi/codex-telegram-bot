import test from "node:test";
import assert from "node:assert/strict";
import {
  mergeAdditionalDirectories,
  planModelReasoningTransition
} from "../src/codex/options.js";

const MODELS = [
  {
    slug: "gpt-5.6-sol",
    supportedReasoning: ["low", "medium", "high", "xhigh", "max", "ultra"].map((effort) => ({
      effort,
      description: ""
    }))
  },
  {
    slug: "gpt-5.6-luna",
    supportedReasoning: ["low", "medium", "high", "xhigh", "max"].map((effort) => ({
      effort,
      description: ""
    }))
  },
  {
    slug: "gpt-5.5",
    supportedReasoning: ["minimal", "low", "medium", "high", "xhigh"].map((effort) => ({
      effort,
      description: ""
    }))
  }
];

test("upload directory is included in Codex additional directories", () => {
  assert.deepEqual(mergeAdditionalDirectories(["/workspace"], "/uploads"), ["/workspace", "/uploads"]);
});

test("additional directory merge removes duplicates", () => {
  assert.deepEqual(mergeAdditionalDirectories(["/uploads", "/workspace"], "/uploads"), ["/uploads", "/workspace"]);
});

test("model transition rejects Luna when configured ultra would become effective", () => {
  assert.deepEqual(
    planModelReasoningTransition({
      models: MODELS,
      modelSlug: "gpt-5.6-luna",
      configuredReasoning: "ultra",
      allowExplicitClear: true
    }),
    { action: "reject", reasoning: "ultra" }
  );
});

test("model transition clears incompatible explicit effort only onto a supported baseline", () => {
  assert.deepEqual(
    planModelReasoningTransition({
      models: MODELS,
      modelSlug: "gpt-5.6-luna",
      explicitReasoning: "ultra",
      configuredReasoning: "ultra",
      allowExplicitClear: true
    }),
    { action: "reject", reasoning: "ultra" }
  );
  assert.deepEqual(
    planModelReasoningTransition({
      models: MODELS,
      modelSlug: "gpt-5.6-luna",
      explicitReasoning: "ultra",
      configuredReasoning: "high",
      allowExplicitClear: true
    }),
    { action: "clear" }
  );
});

test("reasoning default rejects unsupported baseline without changing compatible or custom models", () => {
  assert.deepEqual(
    planModelReasoningTransition({
      models: MODELS,
      modelSlug: "gpt-5.6-luna",
      configuredReasoning: "ultra"
    }),
    { action: "reject", reasoning: "ultra" }
  );
  assert.deepEqual(
    planModelReasoningTransition({
      models: MODELS,
      modelSlug: "gpt-5.5",
      configuredReasoning: "high"
    }),
    { action: "keep" }
  );
  assert.deepEqual(
    planModelReasoningTransition({
      models: MODELS,
      modelSlug: "custom-model",
      explicitReasoning: "ultra",
      configuredReasoning: "ultra",
      allowExplicitClear: true
    }),
    { action: "keep" }
  );
});

test("supported explicit reasoning masks an incompatible configured baseline", () => {
  assert.deepEqual(
    planModelReasoningTransition({
      models: MODELS,
      modelSlug: "gpt-5.6-luna",
      explicitReasoning: "high",
      configuredReasoning: "ultra",
      allowExplicitClear: true
    }),
    { action: "keep" }
  );
});

test("known empty catalogs and disabled explicit clearing reject the effective reasoning", () => {
  const knownEmpty = { slug: "known-empty", supportedReasoning: [] };
  assert.deepEqual(
    planModelReasoningTransition({
      models: [...MODELS, knownEmpty],
      modelSlug: "known-empty",
      configuredReasoning: "high",
      allowExplicitClear: true
    }),
    { action: "reject", reasoning: "high" }
  );
  assert.deepEqual(
    planModelReasoningTransition({
      models: MODELS,
      modelSlug: "gpt-5.6-luna",
      explicitReasoning: "ultra",
      configuredReasoning: "high",
      allowExplicitClear: false
    }),
    { action: "reject", reasoning: "ultra" }
  );
});
