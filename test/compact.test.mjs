import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeContextPressure,
  buildCodexCompactConfig,
  compactPromptForStrength,
  resolveAutoCompactTokenLimit
} from "../src/codex/compact.js";

test("buildCodexCompactConfig maps compact env values to Codex config keys", () => {
  const config = buildCodexCompactConfig({
    codexModelContextWindow: 258400,
    codexAutoCompactTokenLimit: 190000,
    codexToolOutputTokenLimit: 12000,
    codexCompactStrength: "balanced",
    codexCompactPromptFile: "",
    codexContextCompactThresholdPercent: 75
  });

  assert.equal(config.model_context_window, 258400);
  assert.equal(config.model_auto_compact_token_limit, 190000);
  assert.equal(config.tool_output_token_limit, 12000);
  assert.match(config.compact_prompt, /current goal/);
});

test("buildCodexCompactConfig derives auto compact limit from window and percent", () => {
  assert.equal(resolveAutoCompactTokenLimit({
    codexModelContextWindow: 100000,
    codexAutoCompactTokenLimit: 0,
    codexContextCompactThresholdPercent: 75
  }), 75000);
});

test("buildCodexCompactConfig omits native-default context and compact overrides", () => {
  const config = buildCodexCompactConfig({
    codexModelContextWindow: 0,
    codexAutoCompactTokenLimit: 0,
    codexToolOutputTokenLimit: 12000,
    codexCompactStrength: "balanced",
    codexCompactPromptFile: "",
    codexContextCompactThresholdPercent: 75
  });

  assert.equal(Object.hasOwn(config, "model_context_window"), false);
  assert.equal(Object.hasOwn(config, "model_auto_compact_token_limit"), false);
  assert.equal(config.tool_output_token_limit, 12000);
  assert.match(config.compact_prompt, /current goal/);
});

test("compact prompt file takes precedence over strength prompt", () => {
  const config = buildCodexCompactConfig({
    codexModelContextWindow: 0,
    codexAutoCompactTokenLimit: 0,
    codexToolOutputTokenLimit: 0,
    codexCompactStrength: "aggressive",
    codexCompactPromptFile: "/tmp/compact.txt",
    codexContextCompactThresholdPercent: 75
  });

  assert.equal(config.experimental_compact_prompt_file, "/tmp/compact.txt");
  assert.equal(config.compact_prompt, undefined);
});

test("compactPromptForStrength supports leaving Codex default prompt unchanged", () => {
  assert.equal(compactPromptForStrength("default"), "");
});

test("analyzeContextPressure reads latest Codex token count shape", () => {
  const pressure = analyzeContextPressure({
    info: {
      last_token_usage: { input_tokens: 180000 },
      model_context_window: 258400
    }
  });

  assert.equal(pressure.inputTokens, 180000);
  assert.equal(pressure.modelContextWindow, 258400);
  assert.equal(pressure.remainingTokens, 78400);
  assert.equal(Math.round(pressure.percent), 70);
});
