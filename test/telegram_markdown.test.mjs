import test from "node:test";
import assert from "node:assert/strict";
import { formatCodexAnswerMarkdownHtml, formatCodexAnswerSafeHtml } from "../src/telegram/markdown.js";

test("markdown renderer allows safe https links", () => {
  assert.equal(
    formatCodexAnswerMarkdownHtml("[OpenAI](https://openai.com/?q=a&b=c)"),
    '<a href="https://openai.com/?q=a&amp;b=c">OpenAI</a>'
  );
});

test("local result links retain the report path instead of silently dropping it", () => {
  const report = "/workspace/runs/visual/replacement/CHECKPOINT.md";
  assert.equal(
    formatCodexAnswerMarkdownHtml(`[교체 결과 및 새 이미지 링크](${report})`),
    `교체 결과 및 새 이미지 링크 (<code>${report}</code>)`
  );
});

test("local links support spaces, Unicode, balanced parentheses, line references and titles", () => {
  assert.equal(
    formatCodexAnswerMarkdownHtml('[검증 보고서](</tmp/검증 결과 (최종).md:12> "보고서")'),
    '검증 보고서 (<code>/tmp/검증 결과 (최종).md:12</code>)'
  );
  assert.equal(
    formatCodexAnswerMarkdownHtml('[파일](/tmp/result(final).md)'),
    '파일 (<code>/tmp/result(final).md</code>)'
  );
});

test("local destinations are escaped as code and never become Telegram hrefs", () => {
  assert.equal(
    formatCodexAnswerMarkdownHtml('[file](/tmp/a&b<test>.md)'),
    'file (<code>/tmp/a&amp;b&lt;test&gt;.md</code>)'
  );
  assert.equal(
    formatCodexAnswerMarkdownHtml('[file](/tmp/a`b.md)'),
    'file (<code>/tmp/a`b.md</code>)'
  );
  assert.equal(
    formatCodexAnswerMarkdownHtml('[file](file:///tmp/report.md)'),
    'file (<code>file:///tmp/report.md</code>)'
  );
});

test("public links next to local and rejected links keep their full URLs", () => {
  const html = formatCodexAnswerMarkdownHtml(
    '[local](/tmp/report.md) [bad](javascript:alert(1)) [image](<https://example.com/image(a).png?x=1&y=2>)'
  );
  assert.equal(html, 'local (<code>/tmp/report.md</code>) bad <a href="https://example.com/image(a).png?x=1&amp;y=2">image</a>');
});

test("link examples inside code remain literal in the HTML fallback", () => {
  assert.equal(
    formatCodexAnswerMarkdownHtml('`[report](/tmp/file.md)`\n\n```md\n[bad](javascript:alert(1))\n[report](/tmp/file.md)\n```'),
    '<code>[report](/tmp/file.md)</code>\n<pre>md\n[bad](javascript:alert(1))\n[report](/tmp/file.md)\n</pre>'
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
