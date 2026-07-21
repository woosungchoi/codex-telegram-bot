import test from "node:test";
import assert from "node:assert/strict";
import { createTelegramRuntimeContext } from "../src/telegram/runtime_context.js";

function createFixture() {
  const sent = [];
  const chats = new Map();
  const runtime = createTelegramRuntimeContext({
    bot: {
      telegram: {
        sendMessage: async (...args) => { sent.push(["message", ...args]); },
        sendChatAction: async (...args) => { sent.push(["action", ...args]); }
      }
    },
    settings: { personaPrompt: "", uploadMaxBytes: 0, uploadDir: "/tmp/unused" },
    chats: {
      get(chatKey) {
        if (!chats.has(chatKey)) chats.set(chatKey, {});
        return chats.get(chatKey);
      }
    },
    persistence: { save: async () => {} },
    localization: { language: () => "en", text: (key) => key },
    formatting: { bytes: String }
  });
  return { runtime, sent };
}

test("synthetic Telegram context preserves topic and reply routing", async () => {
  const { runtime, sent } = createFixture();
  const ctx = runtime.createSyntheticCtx({
    chatKey: "-100:42",
    chatId: -100,
    chatType: "supergroup",
    messageThreadId: 42,
    replyToMessageId: 9
  });

  assert.equal(ctx.chat.id, -100);
  assert.equal(ctx.message.message_thread_id, 42);
  await ctx.reply("hello");
  await ctx.sendChatAction("typing");
  assert.equal(sent[0][3].message_thread_id, 42);
  assert.equal(sent[0][3].reply_parameters.message_id, 9);
  assert.equal(sent[1][3].message_thread_id, 42);
});

test("command helpers and Telegram metadata normalize runtime input", () => {
  const { runtime } = createFixture();
  const ctx = {
    chat: { id: 7 },
    message: { text: "  /queue next ", message_id: 11, message_thread_id: 3 },
    update: { update_id: 12 }
  };
  assert.equal(runtime.getChatKey(ctx), "7");
  assert.equal(runtime.commandName(ctx), "queue");
  assert.equal(runtime.getCommandArgs(ctx), "next");
  assert.deepEqual(runtime.telegramMessageMeta(ctx), {
    chatType: undefined,
    messageThreadId: 3,
    replyToMessageId: undefined,
    originMessageId: 11,
    originUpdateId: 12
  });
});

test("existing turn contexts are reused without mutation", () => {
  const { runtime } = createFixture();
  const ctx = { chat: { id: 1 } };
  const turn = { ctx };
  assert.equal(runtime.ensureTurnContext(turn), ctx);
  assert.equal(turn.ctx, ctx);
});
