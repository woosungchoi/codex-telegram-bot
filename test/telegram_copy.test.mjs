import test from "node:test";
import assert from "node:assert/strict";
import { codeCopyReplyMarkup } from "../src/telegram/copy.js";
import { replyFormattedCodexAnswer } from "../src/telegram/codex_answer.js";
import { createTelegramRuntimeResponder } from "../src/telegram/runtime_responder.js";
import { textFor } from "../src/i18n.js";

const fence = (text) => `\`\`\`bash\n${text}\n\`\`\``;
const values = (markup) => markup?.inline_keyboard.map(([button]) => button.copy_text.text);

test("copy preserves executable contents without language, fence or HTML escaping", () => {
  const command = '  printf \'%s\\n\' "$HOME"\n\techo "<>&`literal`"  \n';
  const markup = codeCopyReplyMarkup(fence(command), (key) => textFor("ko", key));
  assert.deepEqual(values(markup), [command]);
  assert.equal(markup.inline_keyboard[0][0].text, "📋 코드 1 복사");
});

test("copy respects whole-block Unicode boundaries and original block numbering", () => {
  const answer = [fence("x".repeat(257)), fence("한".repeat(256)), fence("😀".repeat(256))].join("\n\n");
  const markup = codeCopyReplyMarkup(answer);
  assert.deepEqual(values(markup), ["한".repeat(256), "😀".repeat(256)]);
  assert.equal(markup.inline_keyboard[0][0].text, "📋 Copy code 2");
  assert.equal(codeCopyReplyMarkup(fence("😀".repeat(257))), undefined);
});

test("copy skips empty, unclosed, nested and non-fenced code", () => {
  for (const text of [fence("  \n\t"), "```sh\necho x", "````sh\necho x\n```", "`echo x`", "> ```\n> echo x\n> ```", "- ```\n  echo x\n  ```"]) {
    assert.equal(codeCopyReplyMarkup(text), undefined, text);
  }
  assert.deepEqual(values(codeCopyReplyMarkup("~~~sh\r\necho x\r\n~~~~\r\n")), ["echo x"]);
});

test("copy keyboard is bounded without modifying answer contents", () => {
  assert.equal(codeCopyReplyMarkup(Array.from({ length: 30 }, (_, i) => fence(`echo ${i}`)).join("\n")).inline_keyboard.length, 20);
});

function harness() {
  const calls = [];
  const ctx = { chat: { id: 123 }, telegram: { callApi: async (method, payload) => { calls.push({ method, payload }); return {}; } } };
  return { calls, ctx };
}

const noPhotos = async (text) => ({ text, photos: [], rejected: [] });

test("rich answer carries native copy keyboard", async () => {
  const { ctx, calls } = harness();
  await replyFormattedCodexAnswer(ctx, fence("echo ok"), {
    extractPhotoArtifacts: noPhotos, replyHtml: async () => assert.fail(), replyLong: async () => assert.fail()
  });
  assert.equal(calls[0].method, "sendRichMessage");
  assert.deepEqual(values(calls[0].payload.reply_markup), ["echo ok"]);
});

for (const format of ["markdown", "safe"]) {
  test(`${format} fallback attaches original-block keyboard only to last chunk`, async () => {
    const replies = [];
    const answer = fence("x".repeat(1200)) + "\n\n" + fence("echo complete");
    await replyFormattedCodexAnswer({}, answer, {
      format, maxTelegramChars: 500, extractPhotoArtifacts: noPhotos,
      tryRichMarkdown: async () => ({ sent: false }),
      replyHtml: async (_ctx, html, extra) => replies.push({ html, extra }), replyLong: async () => assert.fail()
    });
    assert.ok(replies.length > 1);
    assert.ok(replies.slice(0, -1).every(({ extra }) => !extra.reply_markup));
    assert.deepEqual(values(replies.at(-1).extra.reply_markup), ["echo complete"]);
  });
}

test("plain answer routes copy keyboard through runtime chunking", async () => {
  const replies = [];
  const responder = createTelegramRuntimeResponder({ settings: { runtimeValue: () => 500 } });
  await replyFormattedCodexAnswer({ reply: async (text, extra) => replies.push({ text, extra }) }, "x".repeat(1100) + "\n" + fence("echo ok"), {
    format: "off", extractPhotoArtifacts: noPhotos,
    replyLong: responder.replyLong, replyHtml: async () => assert.fail()
  });
  assert.ok(replies.length > 1);
  assert.ok(replies.slice(0, -1).every(({ extra }) => !extra.reply_markup));
  assert.deepEqual(values(replies.at(-1).extra.reply_markup), ["echo ok"]);
});

test("copy labels follow every supported UI locale without changing clipboard text", () => {
  const labels = { en: "📋 Copy code 1", ko: "📋 코드 1 복사", ru: "📋 Копировать код 1", "zh-tw": "📋 複製程式碼 1" };
  for (const [locale, label] of Object.entries(labels)) {
    const markup = codeCopyReplyMarkup(fence("echo hello"), (key) => textFor(locale, key));
    assert.equal(markup.inline_keyboard[0][0].text, label);
    assert.deepEqual(values(markup), ["echo hello"]);
  }
});
