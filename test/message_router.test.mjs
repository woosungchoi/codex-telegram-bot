import test from "node:test";
import assert from "node:assert/strict";
import {
  registerTelegramMessageRoutes,
  registerTelegramMiddleware
} from "../src/telegram/message_router.js";

test("authorization middleware stops unauthorized updates before command routes", async () => {
  let middleware;
  const replies = [];
  const bot = {
    catch() {},
    use(handler) { middleware = handler; }
  };
  registerTelegramMiddleware({
    bot,
    config: {},
    authorize: () => ({ ok: false }),
    telegram: { replyHtml: async () => {}, summarizeError: () => ({ description: "error" }) }
  });
  let continued = false;
  await middleware({ message: {}, reply: async (text) => replies.push(text) }, async () => {
    continued = true;
  });
  assert.deepEqual(replies, ["Unauthorized."]);
  assert.equal(continued, false);
});

test("PDF document route stores the upload before replying with its path", async () => {
  const handlers = new Map();
  const calls = [];
  const bot = { on(type, handler) { handlers.set(type, handler); } };
  const record = { path: "/tmp/document.pdf" };
  registerTelegramMessageRoutes({
    bot,
    input: {
      downloadFile: async () => "file",
      downloadPdf: async (...args) => {
        calls.push(["download", ...args]);
        return record;
      },
      extensionFromMime: () => ".bin",
      formatUploadedPdf: () => "uploaded",
      getChatKey: () => "chat",
      getFreshLastPdf: () => null,
      handleCodexMessage: async () => {},
      rememberLastPdfUpload: async (...args) => calls.push(["remember", ...args])
    },
    pdf: {
      mergeReferences: String,
      planInput: () => ({ kind: "pdf_upload_only" }),
      shouldUseRecent: () => false
    },
    telegram: { replyHtml: async (...args) => calls.push(["reply", ...args]) },
    localization: { text: (key) => key },
    commands: { isRegistered: () => false }
  });
  const ctx = { message: { document: { file_id: "pdf" } } };
  await handlers.get("document")(ctx);
  assert.deepEqual(calls.map(([name]) => name), ["download", "remember", "reply"]);
  assert.equal(calls[0][3], ctx.message);
});

test("text route ignores registered commands and forwards ordinary text", async () => {
  const handlers = new Map();
  const calls = [];
  const bot = { on(type, handler) { handlers.set(type, handler); } };
  registerTelegramMessageRoutes({
    bot,
    input: {
      downloadFile: async () => "file",
      downloadPdf: async () => ({}),
      extensionFromMime: () => ".bin",
      formatUploadedPdf: () => "uploaded",
      getChatKey: () => "chat",
      getFreshLastPdf: () => null,
      handleCodexMessage: async (_ctx, text) => calls.push(text),
      rememberLastPdfUpload: async () => {}
    },
    pdf: {
      mergeReferences: (text) => text,
      planInput: () => ({ kind: "unsupported" }),
      shouldUseRecent: () => false
    },
    telegram: { replyHtml: async () => {} },
    localization: { text: (key) => key },
    commands: { isRegistered: (message) => message.text.startsWith("/") }
  });
  await handlers.get("text")({ message: { text: "/status" } });
  await handlers.get("text")({ message: { text: " hello " } });
  assert.deepEqual(calls, ["hello"]);
});
