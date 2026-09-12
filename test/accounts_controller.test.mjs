import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers";
import { registerAccountCommands } from "../src/accounts/controller.js";
import { accountFixture } from "./helpers/accounts_fixture.mjs";

async function fixture(t) {
  const f = await accountFixture(t);
  const commands = new Map(), messages = [];
  let callback;
  const state = { ui: { language: "ko" }, chats: { "1": { threadId: "old-thread" } } };
  const r = {
    config: { ...f.config, allowedUserIds: new Set(["1", "2"]), codexAccountAdminUserIds: new Set(["1"]) }, state,
    bot: { command: (name, fn) => commands.set(name, fn), action: (_re, fn) => { callback = fn; }, telegram: { deleteMessage: async () => {} } },
    threadCache: new Map(), getChatKey: () => "1", getChatState: () => state.chats["1"],
    getCommandArgs: (ctx) => ctx.args || "", saveState: async () => {},
    replyHtml: async (_ctx, text, extra) => { messages.push({ text, extra }); return { message_id: messages.length }; }
  };
  const ctx = { from: { id: 1 }, chat: { id: 1, type: "private" }, answerCbQuery: async () => {} };
  return { ...f, r, ctx, commands, messages, callback: (ctx) => callback(ctx) };
}

test("non-admin users and group callbacks cannot manage accounts", async (t) => {
  const f = await fixture(t);
  registerAccountCommands(f.r, { store: f.store });
  await f.commands.get("reauth")({ ...f.ctx, from: { id: 2 } });
  await f.callback({ ...f.ctx, chat: { id: -100, type: "supergroup" }, match: ["", "rotate", "on"] });
  assert.equal((await f.store.read()).autoRotate, false);
  assert.equal((await f.store.list()).length, 1);
  assert.ok(f.messages.every((m) => m.text.includes("개인 채팅")));
});

test("menu selection changes future routing without rewriting the active thread", async (t) => {
  const f = await fixture(t);
  registerAccountCommands(f.r, { store: f.store });
  const a = await f.store.create("<Work>");
  await f.store.update(a.id, { status: "ready" });
  await f.commands.get("accounts")({ ...f.ctx, args: `use ${a.id}` });
  assert.equal(f.r.state.chats["1"].accountId, a.id);
  assert.equal(f.r.state.chats["1"].threadId, "old-thread");
  assert.match(f.messages.at(-1).text, /&lt;Work&gt;/);
  assert.ok(f.messages.at(-1).extra.reply_markup.inline_keyboard.flat().every((b) => Buffer.byteLength(b.callback_data) <= 64));
});

test("login is asynchronous and its one-time code message is removed afterwards", async (t) => {
  const f = await fixture(t);
  let finish;
  const controller = registerAccountCommands(f.r, { store: f.store, signIn: async ({ onCode }) => {
    await onCode({ verificationUrl: "https://auth.openai.com/codex/device", userCode: "ABCD-1234" });
    return new Promise((resolve) => { finish = resolve; });
  } });
  const deleted = [];
  f.r.bot.telegram.deleteMessage = async (...args) => deleted.push(args);
  await f.commands.get("reauth")(f.ctx);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.pending.size, 1);
  const pending = controller.pending.get("1").promise;
  finish({ id: "test", label: "Account" });
  await pending;
  assert.equal(controller.pending.size, 0);
  assert.equal(deleted.length, 1);
  assert.equal(f.messages.find((m) => m.text.includes("ABCD-1234")).extra.protect_content, true);
  assert.doesNotMatch(JSON.stringify(f.r.state), /ABCD|TOKEN/);
});
