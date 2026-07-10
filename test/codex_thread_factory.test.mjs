import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAppServerDirectThreadOptions,
  buildSdkThreadOptions
} from "../src/codex/thread_factory.js";

const RUNTIME_ONLY_OPTIONS = {
  streamEvents: true,
  liveProgressEnabled: true,
  liveProgressSource: "telegram",
  liveProgressDeletePolicy: "always"
};

for (const effort of ["max", "ultra"]) {
  test(`SDK thread options preserve ${effort} reasoning and strip runtime-only options`, () => {
    // Given
    const effectiveOptions = {
      model: "gpt-5.6-sol",
      modelReasoningEffort: effort,
      workingDirectory: "/repo",
      approvalPolicy: "never",
      serviceTier: "fast",
      ...RUNTIME_ONLY_OPTIONS
    };

    // When
    const threadOptions = buildSdkThreadOptions(effectiveOptions);

    // Then
    assert.deepEqual(threadOptions, {
      model: "gpt-5.6-sol",
      modelReasoningEffort: effort,
      workingDirectory: "/repo",
      approvalPolicy: "never"
    });
  });

  test(`app-server thread options preserve ${effort} reasoning and strip runtime-only options`, () => {
    // Given
    const effectiveOptions = {
      model: "gpt-5.6-sol",
      modelReasoningEffort: effort,
      workingDirectory: "/repo",
      serviceTier: "fast",
      ...RUNTIME_ONLY_OPTIONS
    };

    // When
    const threadOptions = buildAppServerDirectThreadOptions({}, effectiveOptions);

    // Then
    assert.deepEqual(threadOptions, {
      model: "gpt-5.6-sol",
      modelReasoningEffort: effort,
      workingDirectory: "/repo",
      serviceTier: "fast"
    });
  });
}

test("SDK thread options leave fabricated reasoning effort for boundary validation", () => {
  // Given
  const effectiveOptions = {
    model: "custom-model",
    modelReasoningEffort: "fabricated-effort",
    streamEvents: true
  };

  // When
  const sdkOptions = buildSdkThreadOptions(effectiveOptions);

  // Then
  assert.deepEqual(sdkOptions, {
    model: "custom-model",
    modelReasoningEffort: "fabricated-effort"
  });
});

test("app-server thread options leave fabricated reasoning effort for boundary validation", () => {
  // Given
  const effectiveOptions = {
    model: "custom-model",
    modelReasoningEffort: "fabricated-effort",
    streamEvents: true
  };

  // When
  const appServerOptions = buildAppServerDirectThreadOptions({}, effectiveOptions);

  // Then
  assert.deepEqual(appServerOptions, {
    model: "custom-model",
    modelReasoningEffort: "fabricated-effort"
  });
});
