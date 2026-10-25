import test from "node:test";
import assert from "node:assert/strict";
import { b, code, escapeHtml, escapeHtmlAttribute, isSafeTelegramHref, pre, stripHtml } from "../src/telegram/html.js";

test("escapeHtml escapes Telegram HTML-sensitive characters", () => {
  assert.equal(escapeHtml("<a&b>\""), "&lt;a&amp;b&gt;&quot;");
});

test("code, pre, and b wrap escaped text", () => {
  assert.equal(code("a < b"), "<code>a &lt; b</code>");
  assert.equal(pre("line 1\nline & 2"), "<pre>line 1\nline &amp; 2</pre>");
  assert.equal(b("hello & bye"), "<b>hello &amp; bye</b>");
});

test("stripHtml recovers readable fallback text", () => {
  assert.equal(stripHtml("<b>Hello</b><br><code>a &lt; b &amp;&amp; c &quot;d&quot;</code>"), "Hello\na < b && c \"d\"");
});

test("Telegram href allowlist only accepts safe absolute protocols", () => {
  assert.equal(isSafeTelegramHref("https://example.com/a?b=1"), true);
  assert.equal(isSafeTelegramHref("http://example.com"), true);
  assert.equal(isSafeTelegramHref("mailto:hello@example.com"), true);
  assert.equal(isSafeTelegramHref("javascript:alert(1)"), false);
  assert.equal(isSafeTelegramHref("/relative/path"), false);
});

test("escapeHtmlAttribute escapes quote-delimited href values", () => {
  assert.equal(escapeHtmlAttribute("https://example.com/?q=\"a&b\""), "https://example.com/?q=&quot;a&amp;b&quot;");
});

test("pre carries language metadata without adding text to copied code", () => {
  for (const language of ["bash", "python", "json", "yaml", "javascript", "c++", "c#"]) {
    const html = pre('  print("<>&")\n', language);
    assert.equal(html, `<pre><code class="language-${language}">  print(&quot;&lt;&gt;&amp;&quot;)\n</code></pre>`);
    assert.equal(stripHtml(html).trimEnd(), '  print("<>&")');
  }
  assert.equal(pre("x", "PYTHON title=example"), '<pre><code class="language-python">x</code></pre>');
});

test("pre rejects unsafe language attributes without losing the code", () => {
  for (const language of ['python"', '<script>', '&quot;', 'a'.repeat(65), '']) {
    assert.equal(pre("x < y", language), '<pre>x &lt; y</pre>');
  }
});
