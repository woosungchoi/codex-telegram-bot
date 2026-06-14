import test from "node:test";
import assert from "node:assert/strict";
import { replyFormattedCodexAnswer } from "../src/telegram/codex_answer.js";
import {
  RICH_MESSAGE_MAX_CHARS,
  buildRichMarkdownPayload,
  cleanUndefinedPayloadFields,
  promoteStandaloneInlineCode,
  shouldFallbackFromRichError,
  telegramThreadIdFromContext,
  tryReplyRichMarkdown
} from "../src/telegram/rich.js";

const RICH_MARKDOWN_FIXTURE = [
  "# 생성한 문서",
  "## 요약",
  "### 세부",
  "",
  "| 항목 | 값 |",
  "|---|---|",
  "| **굵게** | *기울임* |",
  "",
  "---",
  "",
  "- unordered",
  "1. ordered",
  "- [x] task",
  "",
  "Inline code: `/ayc/content-ops`",
  "",
  "```sh",
  "echo \"wide block\"",
  "```"
].join("\n");

function createCtx(overrides = {}) {
  const calls = [];
  const ctx = {
    chat: { id: -100123 },
    msg: { message_id: 77, is_topic_message: true, message_thread_id: 456 },
    telegram: {
      async callApi(method, payload) {
        calls.push({ method, payload });
        if (overrides.error) throw overrides.error;
        return overrides.message ?? { message_id: 1001 };
      }
    },
    calls
  };
  return ctx;
}

test("cleanUndefinedPayloadFields removes undefined fields recursively", () => {
  assert.deepEqual(cleanUndefinedPayloadFields({
    chat_id: 1,
    message_thread_id: undefined,
    nested: { keep: true, drop: undefined },
    list: [{ value: "x", drop: undefined }]
  }), {
    chat_id: 1,
    nested: { keep: true },
    list: [{ value: "x" }]
  });
});

test("telegramThreadIdFromContext returns topic thread id only for topic messages", () => {
  assert.equal(telegramThreadIdFromContext(createCtx()), 456);
  assert.equal(telegramThreadIdFromContext({ msg: { message_thread_id: 456 } }), undefined);
});

test("buildRichMarkdownPayload preserves raw Markdown and optional reply anchor", () => {
  const payload = buildRichMarkdownPayload(createCtx(), RICH_MARKDOWN_FIXTURE, { replyToMessageId: 77 });
  assert.deepEqual(payload, {
    chat_id: -100123,
    message_thread_id: 456,
    rich_message: { markdown: RICH_MARKDOWN_FIXTURE },
    reply_parameters: { message_id: 77 }
  });
});

test("promoteStandaloneInlineCode turns standalone inline code into short code blocks", () => {
  assert.equal(
    promoteStandaloneInlineCode([
      "추천 URL:",
      "",
      "`/ayc/content-ops`",
      "",
      "- list item",
      "  `npm run verify`"
    ].join("\n")),
    [
      "추천 URL:",
      "",
      "```",
      "/ayc/content-ops",
      "```",
      "",
      "- list item",
      "  ```",
      "  npm run verify",
      "  ```"
    ].join("\n")
  );
});

test("promoteStandaloneInlineCode preserves inline sentence code and fenced blocks", () => {
  const markdown = [
    "문장 안 `inline` 코드는 그대로 둔다.",
    "",
    "```sh",
    "`already fenced`",
    "```"
  ].join("\n");
  assert.equal(promoteStandaloneInlineCode(markdown), markdown);
});

test("tryReplyRichMarkdown sends raw Markdown through sendRichMessage", async () => {
  const ctx = createCtx();
  const result = await tryReplyRichMarkdown(ctx, RICH_MARKDOWN_FIXTURE);
  assert.equal(result.sent, true);
  assert.equal(ctx.calls.length, 1);
  assert.equal(ctx.calls[0].method, "sendRichMessage");
  assert.equal(ctx.calls[0].payload.rich_message.markdown, RICH_MARKDOWN_FIXTURE);
  assert.match(ctx.calls[0].payload.rich_message.markdown, /\| 항목 \| 값 \|/);
  assert.match(ctx.calls[0].payload.rich_message.markdown, /^---$/m);
  assert.match(ctx.calls[0].payload.rich_message.markdown, /^### 세부$/m);
  assert.match(ctx.calls[0].payload.rich_message.markdown, /^- \[x\] task$/m);
  assert.match(ctx.calls[0].payload.rich_message.markdown, /\*\*굵게\*\*/);
  assert.match(ctx.calls[0].payload.rich_message.markdown, /\*기울임\*/);
  assert.match(ctx.calls[0].payload.rich_message.markdown, /`\/ayc\/content-ops`/);
  assert.match(ctx.calls[0].payload.rich_message.markdown, /```sh\necho "wide block"\n```/);
});

test("tryReplyRichMarkdown sends standalone inline code as rich pre blocks", async () => {
  const ctx = createCtx();
  await tryReplyRichMarkdown(ctx, [
    "추천 URL:",
    "",
    "`/ayc/content-ops`",
    "",
    "문장 안 `inline` 코드는 그대로"
  ].join("\n"));
  assert.equal(ctx.calls[0].payload.rich_message.markdown, [
    "추천 URL:",
    "",
    "```",
    "/ayc/content-ops",
    "```",
    "",
    "문장 안 `inline` 코드는 그대로"
  ].join("\n"));
});

test("tryReplyRichMarkdown uses fallback signal for rich length limit", async () => {
  const ctx = createCtx();
  const result = await tryReplyRichMarkdown(ctx, "x".repeat(RICH_MESSAGE_MAX_CHARS + 1));
  assert.deepEqual(result, { sent: false, fallback: true, reason: "too_long" });
  assert.equal(ctx.calls.length, 0);
});

test("tryReplyRichMarkdown falls back for capability and parsing failures", async () => {
  const ctx = createCtx({ error: Object.assign(new Error("Bad Request: method not found"), { code: 400 }) });
  const result = await tryReplyRichMarkdown(ctx, RICH_MARKDOWN_FIXTURE);
  assert.equal(result.sent, false);
  assert.equal(result.fallback, true);
  assert.equal(result.reason, "rich_rejected");
});

test("tryReplyRichMarkdown does not fallback on transient network failures", async () => {
  const ctx = createCtx({ error: new Error("ETIMEDOUT while sending request") });
  await assert.rejects(() => tryReplyRichMarkdown(ctx, RICH_MARKDOWN_FIXTURE), /ETIMEDOUT/);
});

test("shouldFallbackFromRichError classifies rich capability and transient failures", () => {
  assert.equal(shouldFallbackFromRichError(Object.assign(new Error("Bad Request: rich_message is invalid"), { code: 400 })), true);
  assert.equal(shouldFallbackFromRichError(new Error("Unsupported method sendRichMessage")), true);
  assert.equal(shouldFallbackFromRichError(new Error("socket hang up")), false);
});

test("markdown answer format tries rich path before HTML fallback", async () => {
  const ctx = createCtx();
  const htmlReplies = [];
  const longReplies = [];
  await replyFormattedCodexAnswer(ctx, RICH_MARKDOWN_FIXTURE, {
    format: "markdown",
    maxTelegramChars: 3500,
    replyHtml: async (_ctx, html) => htmlReplies.push(html),
    replyLong: async (_ctx, text) => longReplies.push(text)
  });
  assert.equal(ctx.calls.length, 1);
  assert.equal(htmlReplies.length, 0);
  assert.equal(longReplies.length, 0);
});

test("markdown answer format falls back to existing HTML renderer on rich rejection", async () => {
  const ctx = createCtx();
  const htmlReplies = [];
  await replyFormattedCodexAnswer(ctx, RICH_MARKDOWN_FIXTURE, {
    format: "markdown",
    maxTelegramChars: 3500,
    tryRichMarkdown: async () => ({ sent: false, fallback: true, reason: "rich_rejected" }),
    replyHtml: async (_ctx, html) => htmlReplies.push(html),
    replyLong: async () => assert.fail("plain long reply should not run")
  });
  assert.equal(htmlReplies.length, 1);
  assert.match(htmlReplies[0], /<b>생성한 문서<\/b>/);
  assert.match(htmlReplies[0], /<code>\/ayc\/content-ops<\/code>/);
  assert.match(htmlReplies[0], /<pre>sh\necho &quot;wide block&quot;\n<\/pre>/);
});

test("safe answer format keeps existing safe HTML renderer without rich path", async () => {
  const ctx = createCtx();
  const htmlReplies = [];
  await replyFormattedCodexAnswer(ctx, "**bold** `x < y`", {
    format: "safe",
    maxTelegramChars: 3500,
    replyHtml: async (_ctx, html) => htmlReplies.push(html),
    replyLong: async () => assert.fail("plain long reply should not run")
  });
  assert.equal(ctx.calls.length, 0);
  assert.deepEqual(htmlReplies, ["**bold** <code>x &lt; y</code>"]);
});

test("off answer format keeps existing plain text long reply", async () => {
  const ctx = createCtx();
  const longReplies = [];
  await replyFormattedCodexAnswer(ctx, RICH_MARKDOWN_FIXTURE, {
    format: "off",
    maxTelegramChars: 3500,
    replyHtml: async () => assert.fail("html reply should not run"),
    replyLong: async (_ctx, text) => longReplies.push(text)
  });
  assert.equal(ctx.calls.length, 0);
  assert.deepEqual(longReplies, [RICH_MARKDOWN_FIXTURE]);
});

test("long markdown answers exceed rich limit and use existing split fallback", async () => {
  const ctx = createCtx();
  const htmlReplies = [];
  await replyFormattedCodexAnswer(ctx, "x".repeat(RICH_MESSAGE_MAX_CHARS + 1), {
    format: "markdown",
    maxTelegramChars: 3500,
    replyHtml: async (_ctx, html) => htmlReplies.push(html),
    replyLong: async () => assert.fail("plain long reply should not run")
  });
  assert.equal(ctx.calls.length, 0);
  assert.ok(htmlReplies.length > 1);
  assert.ok(htmlReplies.every((html) => html.length <= 3500));
});
