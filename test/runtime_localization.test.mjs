import test from "node:test";
import assert from "node:assert/strict";
import {
  createRuntimeLocalization,
  parseLanguage,
  parseLocale,
  parseTimeZone
} from "../src/ui/runtime_localization.js";

test("runtime localization normalizes invalid persisted preferences", () => {
  assert.equal(parseLanguage("unknown"), "en");
  assert.equal(parseTimeZone("Not/AZone"), "UTC");
  assert.equal(parseLocale("not_a_locale"), "en-US");
});

test("runtime localization interpolates values in the selected language", () => {
  const localization = createRuntimeLocalization({
    state: { ui: { language: "en", timeZone: "UTC", locale: "en-US" } },
    config: {}
  });
  assert.equal(localization.language(), "en");
  assert.match(localization.formatText("telegramDeliveryPending", { count: 2 }), /2/);
});
