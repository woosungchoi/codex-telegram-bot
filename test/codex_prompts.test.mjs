import test from "node:test";
import assert from "node:assert/strict";
import {
  buildStyleInstructionPrompt,
  defaultPersonaPrompt,
  defaultRichMarkdownPrompt
} from "../src/codex/prompts.js";

test("default style instructions include English rich Markdown guidance", () => {
  const prompt = buildStyleInstructionPrompt({ language: "en" });
  assert.match(prompt, /Response style instructions:/);
  assert.match(prompt, /Telegram Rich Markdown formatting instructions:/);
  assert.match(prompt, /Markdown tables/);
  assert.match(prompt, /inline code/);
  assert.match(prompt, /fenced code blocks/);
  assert.match(prompt, /\*\*bold\*\*/);
  assert.match(prompt, /Avoid compressing substantial answers into one dense paragraph/);
  assert.match(prompt, /Telegram-friendly layout/);
});

test("default style instructions include Korean rich Markdown guidance", () => {
  const prompt = buildStyleInstructionPrompt({ language: "ko" });
  assert.match(prompt, /응답 스타일 지침:/);
  assert.match(prompt, /Telegram Rich Markdown 서식 지침:/);
  assert.match(prompt, /Markdown 표/);
  assert.match(prompt, /inline code/);
  assert.match(prompt, /fenced code block/);
  assert.match(prompt, /\*\*bold\*\*/);
  assert.match(prompt, /빽빽한 문단으로 압축하지 않습니다/);
  assert.match(prompt, /Telegram에서 읽기 좋게 구분합니다/);
});

test("custom persona prompt is combined with persistent rich Markdown guidance", () => {
  const prompt = buildStyleInstructionPrompt({
    language: "ko",
    personaPrompt: "사용자 지정 말투"
  });
  assert.match(prompt, /^사용자 지정 말투\n\nTelegram Rich Markdown 서식 지침:/);
  assert.doesNotMatch(prompt, /응답 스타일 지침:/);
  assert.match(prompt, /Markdown table/);
});

test("unsupported prompt language falls back to English", () => {
  assert.equal(defaultPersonaPrompt("missing"), defaultPersonaPrompt("en"));
  assert.equal(defaultRichMarkdownPrompt("missing"), defaultRichMarkdownPrompt("en"));
});
