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
