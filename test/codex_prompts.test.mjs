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
  assert.match(prompt, /Use Markdown tables only when they are compact and likely to fit on mobile/);
  assert.match(prompt, /For long explanatory comparisons, prefer bullets or short key\/value sections/);
});

test("style instructions keep image tool output bounded and rotate long image sessions", () => {
  const prompt = buildStyleInstructionPrompt({ language: "en" });
  assert.match(prompt, /never return multiple images in one tool result/);
  assert.match(prompt, /Never include raw image bytes, data URLs, or base64/);
  assert.match(prompt, /path, pixel dimensions, byte size, and SHA-256 hash/);
  assert.match(prompt, /one small low-resolution thumbnail/);
  assert.match(prompt, /at most 10 images in one conversation thread/);
  assert.match(prompt, /fresh \/new thread/);
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
  assert.match(prompt, /표는 짧고 모바일에서 한눈에 들어갈 때만 사용합니다/);
  assert.match(prompt, /긴 설명형 비교는 bullet 또는 짧은 key\/value 섹션을 우선합니다/);
});

test("default style instructions include Traditional Chinese rich Markdown guidance", () => {
  const prompt = buildStyleInstructionPrompt({ language: "zh-tw" });
  assert.match(prompt, /回覆風格指引：/);
  assert.match(prompt, /Telegram Rich Markdown 格式指引：/);
  assert.match(prompt, /繁體中文/);
  assert.match(prompt, /Markdown 表格/);
  assert.match(prompt, /inline code/);
  assert.match(prompt, /fenced code block/);
  assert.match(prompt, /\*\*bold\*\*/);
  assert.match(prompt, /不要把大量內容壓縮成一個密集段落/);
  assert.match(prompt, /Telegram 友善的版面/);
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
