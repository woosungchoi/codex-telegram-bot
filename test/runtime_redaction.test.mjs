import test from "node:test";
import assert from "node:assert/strict";
import { createRuntimeRedactor } from "../src/runtime/redaction.js";

test("runtime redactor removes configured and token-shaped secrets", () => {
  const redactor = createRuntimeRedactor({
    telegramBotToken: "123456789:abcdefghijklmnopqrstuvwxyz",
    codexApiKey: "sk-configured-secret-value-1234567890"
  });
  const text = redactor.redactText(
    "123456789:abcdefghijklmnopqrstuvwxyz sk-configured-secret-value-1234567890 sess-abcdefghijklmnopqrstuvwxyz"
  );
  assert.doesNotMatch(text, /abcdefghijklmnopqrstuvwxyz/);
  assert.match(text, /REDACTED_TELEGRAM_TOKEN/);
  assert.match(text, /REDACTED_CODEX_API_KEY/);
  assert.match(text, /REDACTED_SECRET/);
});

test("runtime redactor preserves object shape", () => {
  const redactor = createRuntimeRedactor({
    telegramBotToken: "secret-token-value",
    codexApiKey: ""
  });
  assert.deepEqual(redactor.redactValue({ token: "secret-token-value", safe: true }), {
    token: "[REDACTED_TELEGRAM_TOKEN]",
    safe: true
  });
});
