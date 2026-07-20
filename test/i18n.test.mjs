import test from "node:test";
import assert from "node:assert/strict";
import { LANGUAGE_CHOICES, TELEGRAM_LANGUAGE_CODES, VALID_LANGUAGES, textFor } from "../src/i18n.js";

test("Traditional Chinese locale is loaded and selectable", () => {
  assert.equal(VALID_LANGUAGES.has("zh-tw"), true);
  const choice = LANGUAGE_CHOICES.find(({ code }) => code === "zh-tw");
  assert.deepEqual(choice, {
    code: "zh-tw",
    emoji: "🇹🇼",
    nativeName: "繁體中文",
    englishName: "Traditional Chinese",
    telegramLanguageCode: "zh"
  });
  assert.equal(TELEGRAM_LANGUAGE_CODES.includes("zh"), true);
  assert.equal(textFor("zh-tw", "language"), "語言");
});

test("selection cancellation and menu close copy is localized in every UI language", () => {
  const keys = [
    "modelSelectionCancelled",
    "reasoningSelectionCancelled",
    "selectionExpired",
    "selectionFinalizing",
    "selectionUpdateFailed",
    "menuClosed",
    "close"
  ];
  for (const language of VALID_LANGUAGES) {
    for (const key of keys) assert.notEqual(textFor(language, key), key, `${language}:${key}`);
  }
  assert.equal(textFor("ko", "menuClosed"), "메뉴를 닫았습니다.");
  assert.equal(textFor("en", "modelSelectionCancelled"), "Model selection cancelled.");
});
