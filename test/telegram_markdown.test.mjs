import test from "node:test";
import assert from "node:assert/strict";
import { formatCodexAnswerMarkdownHtml, formatCodexAnswerSafeHtml } from "../src/telegram/markdown.js";

test("markdown renderer allows safe https links", () => {
  assert.equal(
    formatCodexAnswerMarkdownHtml("[OpenAI](https://openai.com/?q=a&b=c)"),
    '<a href="https://openai.com/?q=a&amp;b=c">OpenAI</a>'
  );
});

test("markdown renderer blocks javascript links", () => {
  const html = formatCodexAnswerMarkdownHtml("[bad](javascript:alert(1))");
  assert.equal(html, "bad");
  assert.doesNotMatch(html, /javascript:/i);
  assert.doesNotMatch(html, /href=/i);
});

test("markdown renderer escapes raw script tags", () => {
  const html = formatCodexAnswerMarkdownHtml("<script>alert(1)</script>");
  assert.equal(html, "&lt;script&gt;alert(1)&lt;/script&gt;");
});

test("markdown renderer preserves fenced code blocks as Telegram pre", () => {
  const html = formatCodexAnswerMarkdownHtml("```js\nconst x = 1 < 2;\n```");
  assert.equal(html, "<pre>js\nconst x = 1 &lt; 2;\n</pre>");
});

test("markdown renderer keeps two-column tables readable in HTML fallback", () => {
  const html = formatCodexAnswerMarkdownHtml([
    "의미 요약 🧠",
    "",
    "| 문구 | 실제 기능 |",
    "|---|---|",
    "| Spawn isolated subagents | `delegate_task`로 child agent를 생성해 작업 분리 |",
    "| parallel workstreams | 여러 task를 병렬 실행 |"
  ].join("\n"));

  assert.doesNotMatch(html, /문구실제 기능/);
  assert.match(html, /- <b>문구:<\/b> Spawn isolated subagents/);
  assert.match(html, /  <b>실제 기능:<\/b> <code>delegate_task<\/code>로 child agent를 생성해 작업 분리/);
  assert.match(html, /- <b>문구:<\/b> parallel workstreams/);
});

test("markdown renderer formats wider tables as preformatted fallback", () => {
  const html = formatCodexAnswerMarkdownHtml([
    "| 항목 | 값 | 상태 |",
    "|---|---|---|",
    "| alpha | 1 | ok |",
    "| beta | 200 | warn |"
  ].join("\n"));

  assert.match(html, /^<pre>/);
  assert.match(html, /항목\s+\| 값\s+\| 상태/);
  assert.match(html, /alpha\s+\| 1\s+\| ok/);
  assert.match(html, /beta\s+\| 200\s+\| warn/);
  assert.match(html, /<\/pre>$/);
});

test("markdown renderer leaves pipe tables inside fences as Telegram pre", () => {
  const html = formatCodexAnswerMarkdownHtml("```md\n| A | B |\n|---|---|\n| 1 | 2 |\n```");
  assert.equal(html, "<pre>md\n| A | B |\n|---|---|\n| 1 | 2 |\n</pre>");
});

test("safe renderer preserves fenced code blocks and inline code only", () => {
  const html = formatCodexAnswerSafeHtml("**bold** `x < y`\n```sh\necho \"hi\"\n```");
  assert.equal(html, "**bold** <code>x &lt; y</code>\n<pre>sh\necho &quot;hi&quot;\n</pre>");
});
