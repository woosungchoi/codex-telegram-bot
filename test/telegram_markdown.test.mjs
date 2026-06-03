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

test("safe renderer preserves fenced code blocks and inline code only", () => {
  const html = formatCodexAnswerSafeHtml("**bold** `x < y`\n```sh\necho \"hi\"\n```");
  assert.equal(html, "**bold** <code>x &lt; y</code>\n<pre>sh\necho &quot;hi&quot;\n</pre>");
});
