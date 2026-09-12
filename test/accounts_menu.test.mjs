import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { Telegraf } from "telegraf";
import { registerAccountCommands } from "../src/accounts/controller.js";
import { accountHome } from "../src/accounts/store.js";
import { editOrReplyTelegramHtml } from "../src/telegram/api.js";
import { createRuntimeKeyboardViews } from "../src/ui/keyboards.js";
import { createStandaloneModelSelectionController } from "../src/ui/standalone_model_selection_controller.js";
import { accountFixture } from "./helpers/accounts_fixture.mjs";

async function fixture(t, options = {}) {
  const storage = await accountFixture(t);
  return boot(t, { ...storage, clock: { now: Date.now() } }, options);
}

function boot(t, storage, options = {}) {
  const bot = new Telegraf("123:test");
  bot.botInfo = { id: 123, is_bot: true, first_name: "Test Bot", username: "test_bot" };
  const messages = [], forwarded = [], apiCalls = [], signIns = [], otherCommands = [];
  let seq = 100;
  const api = async (method, payload) => {
    apiCalls.push({ method, payload });
    if (method === "editMessageText") {
      const message = messages.find((item) => item.message_id === payload.message_id);
      if (message) Object.assign(message, {
        html: payload.text, text: payload.text.replace(/<[^>]*>/g, ""),
        extra: { ...message.extra, reply_markup: payload.reply_markup }
      });
    }
    return true;
  };
  bot.telegram.callApi = api;
  bot.use((ctx, next) => { ctx.telegram.callApi = api; return next(); });
  bot.catch((error) => { throw error; });
  const state = options.state || { ui: { language: "ko" }, chats: { "1": { threadId: "original-thread" } } };
  let saved = JSON.stringify(state);
  const r = {
    bot, state,
    config: { ...storage.config, allowedUserIds: new Set(["1", "2"]), codexAccountAdminUserIds: new Set(["1"]) },
    threadCache: new Map(), getChatKey: () => "1", getChatState: () => state.chats["1"],
    getCommandArgs: (ctx) => ctx.message.text.replace(/^\/\S+\s*/, ""),
    saveState: async () => { saved = JSON.stringify(state); },
    editOrReplyHtml: editOrReplyTelegramHtml,
    formatDateTime: (ms) => new Date(ms).toISOString(),
    replyHtml: async (ctx, html, extra) => {
      const message = {
        message_id: ++seq, date: 0, from: bot.botInfo, chat: ctx.chat,
        text: html.replace(/<[^>]*>/g, ""), html, extra
      };
      messages.push(message);
      return message;
    }
  };
  const signIn = options.signIn || (async ({ label, store, onCode }) => {
    signIns.push(label);
    const account = await store.create(label);
    await onCode({ verificationUrl: "https://auth.openai.com/codex/device", userCode: "TEST-1234" });
    return store.update(account.id, { status: "ready" });
  });
  const controller = registerAccountCommands(r, { store: storage.store, signIn, readUsage: options.readUsage, consumeCredit: options.consumeCredit, now: () => storage.clock.now });
  t.after(() => controller.close());
  const text = (key) => key;
  const views = createRuntimeKeyboardViews({ text, hasActiveTurn: () => false });
  const { handleMenuClose } = createStandaloneModelSelectionController({
    text, views,
    telegram: {
      editStrict: async (ctx, html, extra) => { await ctx.editMessageText(html, extra); return true; },
      answerUiCallback: (ctx) => ctx.answerCbQuery()
    }
  });
  bot.command("menu", (ctx) => r.replyHtml(ctx, "Main menu", views.mainPanelKeyboard("1")));
  bot.action("ui:close:menu", handleMenuClose);
  bot.command("help", () => { otherCommands.push("help"); });
  bot.action("main:help", async (ctx) => { await ctx.answerCbQuery(); otherCommands.push("main:help"); });
  bot.on("message", (ctx) => { forwarded.push(ctx.message); });
  const user = (id = 1) => ({ id, is_bot: false, first_name: "Test" });
  const send = (text, { userId = 1, chat = { id: 1, type: "private" }, replyTo, photo } = {}) => bot.handleUpdate({
    update_id: ++seq,
    message: {
      message_id: ++seq, date: 0, from: user(userId), chat, text,
      ...(text?.startsWith("/") ? { entities: [{ type: "bot_command", offset: 0, length: text.split(/\s/)[0].length }] } : {}),
      ...(replyTo ? { reply_to_message: replyTo } : {}), ...(photo ? { photo: [] } : {})
    }
  });
  const click = (data, message = messages.at(-1), { userId = 1, chat } = {}) => bot.handleUpdate({
    update_id: ++seq,
    callback_query: { id: `callback-${seq}`, from: user(userId), chat_instance: "test", data,
      message: { ...message, ...(chat ? { chat } : {}) } }
  });
  const finishLogin = () => Promise.all([...controller.pending.values()].map((session) => session.promise));
  const buttons = (message = messages.at(-1)) => message.extra?.reply_markup?.inline_keyboard?.flat() || [];
  const buttonData = (prefix, message = messages.at(-1)) => {
    const found = buttons(message).find((button) => button.callback_data?.startsWith(prefix));
    assert.ok(found, `Expected button ${prefix}`);
    return found.callback_data;
  };
  return {
    ...storage, r, controller, messages, forwarded, apiCalls, signIns, otherCommands,
    send, click, buttons, buttonData, finishLogin,
    savedState: () => JSON.parse(saved),
    restart: () => boot(t, storage, { ...options, state: JSON.parse(saved) })
  };
}

test("account menu accepts a name before device login and offers navigation afterwards", async (t) => {
  const f = await fixture(t);
  await f.send("/accounts");
  assert.ok(f.buttons().some((button) => button.callback_data === "acct:rename:default"));
  assert.ok(f.buttons().every((button) => Buffer.byteLength(button.callback_data) <= 64));
  await f.click(f.buttonData("acct:login"));
  assert.match(f.messages.at(-1).text, /다음 메시지/);
  assert.equal(f.signIns.length, 0);
  assert.equal(f.savedState().accountUi["1:1"].kind, "login");
  await f.send("업무용 계정");
  await f.finishLogin();
  assert.deepEqual(f.signIns, ["업무용 계정"]);
  assert.equal((await f.store.list()).at(-1).label, "업무용 계정");
  assert.equal(f.savedState().accountUi["1:1"], undefined);
  assert.equal(f.forwarded.length, 0);
  assert.ok(f.buttons().some((button) => button.callback_data === "acct:list"));
  assert.ok(f.messages.find((message) => message.text.includes("TEST-1234")).extra.protect_content);
  assert.ok(f.apiCalls.some((call) => call.method === "deleteMessage"));
});

test("invalid name input stays in the account menu and can be corrected", async (t) => {
  const f = await fixture(t);
  await f.send("/accounts");
  await f.click("acct:login");
  for (const input of ["   ", "a".repeat(49), "\u0000"]) {
    await f.send(input);
    assert.match(f.messages.at(-1).text, /1~48/);
  }
  await f.send(undefined, { photo: true });
  assert.match(f.messages.at(-1).text, /텍스트/);
  assert.equal(f.signIns.length, 0);
  assert.equal(f.forwarded.length, 0);
  await f.send("이름 수정");
  await f.finishLogin();
  assert.deepEqual(f.signIns, ["이름 수정"]);
});

test("rename buttons update saved and default labels without changing credentials or selection", async (t) => {
  const f = await fixture(t);
  const account = await f.store.create("Old");
  f.r.state.chats["1"].accountId = account.id;
  await f.send("/accounts");
  await f.click(`acct:rename:${account.id}`);
  await f.send("<업무> 계정");
  assert.equal((await f.store.get(account.id)).label, "<업무> 계정");
  assert.match(f.messages.at(-1).html, /&lt;업무&gt; 계정/);
  await f.click("acct:rename:default");
  await f.send("개인용");
  assert.equal((await f.store.get("default")).label, "개인용");
  assert.equal(f.r.state.chats["1"].accountId, account.id);
  assert.equal(f.r.state.chats["1"].threadId, "original-thread");
  assert.equal(await fs.readFile(path.join(f.config.codexHome, "auth.json"), "utf8"), "HOST_TOKEN_SENTINEL");
  assert.equal(f.forwarded.length, 0);
});

test("cancel and slash commands release name input while replies to old prompts are rejected", async (t) => {
  const f = await fixture(t);
  await f.send("/accounts");
  await f.click("acct:rename:default");
  const prompt = f.messages.at(-1);
  await f.click(f.buttonData("acct:cancelui:"), prompt);
  await f.send("늦은 이름", { replyTo: prompt });
  assert.match(f.messages.at(-1).text, /만료/);
  assert.equal((await f.store.get("default")).label, "Default");
  assert.equal(f.forwarded.length, 0);
  await f.send("일반 대화");
  assert.equal(f.forwarded.length, 1);
  await f.click("acct:rename:default");
  await f.send("/help");
  assert.deepEqual(f.otherCommands, ["help"]);
  assert.equal(f.savedState().accountUi["1:1"], undefined);
  await f.click("acct:rename:default");
  const before = f.apiCalls.filter((call) => call.method === "answerCallbackQuery").length;
  await f.click("main:help");
  assert.deepEqual(f.otherCommands, ["help", "main:help"]);
  assert.equal(f.savedState().accountUi["1:1"], undefined);
  assert.equal(f.apiCalls.filter((call) => call.method === "answerCallbackQuery").length, before + 1);
});

test("name steps survive restart but expire without forwarding the submitted name", async (t) => {
  const f = await fixture(t);
  await f.send("/accounts");
  await f.click("acct:rename:default");
  const restarted = f.restart();
  await restarted.send("재시작 후 이름");
  assert.equal((await f.store.get("default")).label, "재시작 후 이름");
  await restarted.click("acct:rename:default");
  restarted.clock.now += 5 * 60_000;
  await restarted.send("만료된 입력");
  assert.match(restarted.messages.at(-1).text, /만료/);
  assert.equal((await f.store.get("default")).label, "재시작 후 이름");
  assert.equal(restarted.forwarded.length, 0);
});

test("stale Cancel buttons and replies cannot change a newer name prompt", async (t) => {
  const f = await fixture(t);
  await f.send("/accounts");
  await f.click("acct:rename:default");
  const oldPrompt = f.messages.at(-1), oldCancel = f.buttonData("acct:cancelui:");
  await f.click("acct:rename:default");
  const newPrompt = f.messages.at(-1), token = f.savedState().accountUi["1:1"].token;
  await f.click(oldCancel, oldPrompt);
  await f.send("古い入力", { replyTo: oldPrompt });
  assert.equal(f.savedState().accountUi["1:1"].token, token);
  await f.send("새 이름", { replyTo: newPrompt });
  assert.equal((await f.store.get("default")).label, "새 이름");
  assert.equal(f.forwarded.length, 0);
});

test("removal needs a matching confirmation; cancellation and replay cannot remove accounts", async (t) => {
  const f = await fixture(t);
  const account = await f.store.create("삭제 대상");
  await f.store.update(account.id, { status: "ready" });
  f.r.state.chats["1"] = { accountId: account.id, threadAccountId: account.id, threadId: "owned-thread", accountThreads: { [account.id]: "owned-thread", default: "keep" } };
  f.r.threadCache.set("1", {});
  await f.send("/accounts");
  await f.click(`acct:remove:${account.id}`);
  const oldPrompt = f.messages.at(-1), oldConfirm = f.buttonData("acct:confirm:");
  assert.match(oldPrompt.text, /삭제 대상/);
  assert.ok(await fs.stat(accountHome(f.config, account.id)));
  await f.send("삭제");
  assert.match(f.messages.at(-1).text, /버튼/);
  await f.click(f.buttonData("acct:cancelui:", oldPrompt), oldPrompt);
  await f.click(oldConfirm, oldPrompt);
  assert.equal((await f.store.get(account.id)).label, "삭제 대상");
  await f.click(`acct:remove:${account.id}`);
  const prompt = f.messages.at(-1), confirm = f.buttonData("acct:confirm:");
  await f.click(confirm, { ...prompt, message_id: prompt.message_id + 1000 });
  assert.equal((await f.store.get(account.id)).label, "삭제 대상");
  await f.click(confirm, prompt);
  assert.deepEqual((await f.store.list()).map((item) => item.id), ["default"]);
  await assert.rejects(fs.stat(accountHome(f.config, account.id)), { code: "ENOENT" });
  assert.deepEqual(f.r.state.chats["1"], { accountId: "default", accountThreads: { default: "keep" } });
  assert.equal(f.r.threadCache.has("1"), false);
  await f.click(confirm, prompt);
  assert.match(f.messages.at(-1).text, /만료/);
  assert.equal(f.forwarded.length, 0);
});

test("legacy delete buttons require a fresh confirmation and active accounts remain protected", async (t) => {
  const f = await fixture(t);
  const account = await f.store.create("Running");
  await f.store.update(account.id, { status: "ready" });
  const release = await f.store.acquire(account.id);
  t.after(release);
  await f.send("/accounts");
  await f.click(`acct:delete:${account.id}`);
  assert.ok(await f.store.get(account.id));
  await f.click(f.buttonData("acct:confirm:"));
  assert.match(f.messages.at(-1).text, /running task/);
  assert.ok(await f.store.get(account.id));
  await f.click("acct:remove:default");
  assert.match(f.messages.at(-1).text, /기본 계정/);
  assert.equal(f.savedState().accountUi["1:1"], undefined);
});

test("persisted deletion confirmations retain their binding and expiry across restart", async (t) => {
  const f = await fixture(t);
  const account = await f.store.create("Keep until confirmed");
  await f.send("/accounts");
  await f.click(`acct:remove:${account.id}`);
  const expiredPrompt = f.messages.at(-1), expiredConfirm = f.buttonData("acct:confirm:");
  const restarted = f.restart();
  restarted.clock.now += 5 * 60_000;
  await restarted.click(expiredConfirm, expiredPrompt);
  assert.ok(await f.store.get(account.id));
  assert.match(restarted.messages.at(-1).text, /만료/);
  await restarted.click(`acct:remove:${account.id}`);
  const prompt = restarted.messages.at(-1), confirm = restarted.buttonData("acct:confirm:");
  const again = restarted.restart();
  await again.click(confirm, prompt);
  assert.deepEqual((await f.store.list()).map((item) => item.id), ["default"]);
});

test("foreign users and group callbacks cannot submit or cancel account menu steps", async (t) => {
  const f = await fixture(t);
  await f.send("/accounts");
  await f.click("acct:rename:default");
  const prompt = f.messages.at(-1), cancel = f.buttonData("acct:cancelui:");
  await f.click(cancel, prompt, { userId: 2 });
  assert.match(f.messages.at(-1).text, /개인 채팅/);
  await f.send("not-admin", { userId: 2, replyTo: prompt });
  assert.match(f.messages.at(-1).text, /개인 채팅/);
  await f.click(cancel, prompt, { chat: { id: -100, type: "supergroup" } });
  assert.match(f.messages.at(-1).text, /개인 채팅/);
  await f.send("관리자 이름");
  assert.equal((await f.store.get("default")).label, "관리자 이름");
  assert.equal(f.forwarded.length, 0);
});

test("concurrent name submissions start only one login", async (t) => {
  const f = await fixture(t);
  await f.send("/accounts");
  await f.click("acct:login");
  await Promise.all([f.send("첫 이름"), f.send("중복 이름")]);
  await f.finishLogin();
  assert.deepEqual(f.signIns, ["첫 이름"]);
  assert.equal(f.forwarded.length, 0);
});

test("account name commands remain available alongside menu input", async (t) => {
  const f = await fixture(t);
  await f.send("/accounts rename default 기본 계정");
  assert.equal((await f.store.get("default")).label, "기본 계정");
  await f.send("/reauth 명령으로 등록");
  await f.finishLogin();
  assert.deepEqual(f.signIns, ["명령으로 등록"]);
  assert.equal(f.forwarded.length, 0);
});

test("main menu account buttons open the guarded list and registration prompt", async (t) => {
  const f = await fixture(t);
  await f.send("/menu");
  const menu = f.messages.at(-1);
  const list = f.buttonData("acct:list", menu), add = f.buttonData("acct:login", menu);
  await f.click(list, menu);
  assert.match(f.messages.at(-1).text, /Codex 계정/);
  assert.match(f.messages.at(-1).html, /\/accounts rename &lt;id&gt; &lt;이름&gt;/);
  await f.click(add, menu);
  assert.equal(f.savedState().accountUi["1:1"].kind, "login");
  await f.send("메뉴에서 등록");
  await f.finishLogin();
  assert.deepEqual(f.signIns, ["메뉴에서 등록"]);
  await f.click(list, menu, { userId: 2 });
  assert.match(f.messages.at(-1).text, /개인 채팅/);
});

test("account list closes through the shared menu handler without changing accounts", async (t) => {
  const f = await fixture(t);
  await f.send("/accounts");
  const close = f.buttons().filter((button) => button.callback_data === "ui:close:menu");
  assert.deepEqual(close, [{ text: "닫기", callback_data: "ui:close:menu" }]);
  await f.click(close[0].callback_data);
  const edit = f.apiCalls.find((call) => call.method === "editMessageText");
  assert.equal(edit.payload.text, "menuClosed");
  assert.deepEqual(edit.payload.reply_markup.inline_keyboard, []);
  assert.equal(f.apiCalls.filter((call) => call.method === "answerCallbackQuery").length, 1);
  assert.deepEqual((await f.store.list()).map((account) => account.id), ["default"]);
});

test("closing name and deletion prompts clears their pending operations", async (t) => {
  const f = await fixture(t);
  await f.send("/accounts");
  await f.click("acct:rename:default");
  await f.click(f.buttonData("ui:close:menu"));
  assert.equal(f.savedState().accountUi["1:1"], undefined);
  await f.send("일반 요청");
  assert.equal(f.forwarded.length, 1);
  assert.equal((await f.store.get("default")).label, "Default");
  const account = await f.store.create("보존할 계정");
  await f.send("/accounts");
  await f.click(`acct:remove:${account.id}`);
  const prompt = f.messages.at(-1), confirm = f.buttonData("acct:confirm:");
  await f.click(f.buttonData("ui:close:menu"), prompt);
  assert.equal(f.savedState().accountUi["1:1"], undefined);
  await f.click(confirm, prompt);
  assert.ok(await f.store.get(account.id));
  assert.match(f.messages.at(-1).text, /만료/);
});

function usageSample(usedPercent = 52) {
  return {
    account: { type: "chatgpt", planType: "pro" },
    rateLimits: { limitId: "codex", primary: { usedPercent, windowDurationMins: 10080, resetsAt: 1789435487 } },
    rateLimitResetCredits: { availableCount: 3, credits: [{ id: "HIDDEN_CREDIT_ID", title: "Full reset", expiresAt: 1789949489 }] },
    checkedAt: Date.parse("2026-09-12T05:59:00Z")
  };
}

function resetUsage(count = 2) {
  return {
    ...usageSample(), rateLimitResetCredits: {
      availableCount: count,
      credits: Array.from({ length: count }, (_, index) => ({
        id: `OPAQUE:credit/${index}`, title: `Reset <${index + 1}>`, description: "Reset an eligible limit & continue.",
        resetType: "codexRateLimits", status: "available", expiresAt: null
      }))
    }
  };
}

test("account Reset buttons select a specific credit, confirm consumption, and refresh the same account", async (t) => {
  const reads = [], consumes = [];
  const f = await fixture(t, {
    readUsage: async (_config, id) => { reads.push(id); return resetUsage(consumes.length ? 1 : 2); },
    consumeCredit: async (_config, id, params) => {
      assert.deepEqual(f.savedState().accountResetAttempts[id].idempotencyKey, params.idempotencyKey);
      assert.equal(f.savedState().accountUi["1:1"], undefined);
      await assert.rejects(f.store.remove(id), /running task/);
      consumes.push({ id, params });
      return { outcome: "reset" };
    }
  });
  const managed = await f.store.create("Work <B>");
  await f.store.update(managed.id, { status: "ready" });
  const before = JSON.parse(JSON.stringify(f.r.state.chats));
  const cache = { id: "cached-thread" };
  f.r.threadCache.set("1", cache);
  await f.send("/accounts");
  await f.click(f.buttonData("acct:reset"));
  await f.click(`acct:reset:${managed.id}`);
  assert.match(f.messages.at(-1).html, /Work &lt;B&gt;/);
  assert.match(f.messages.at(-1).html, /Reset &lt;2&gt;/);
  assert.equal(f.buttons().filter((b) => b.callback_data.startsWith("acct:resetpick:")).length, 2);
  for (const message of f.messages) assert.doesNotMatch(JSON.stringify(message), /OPAQUE:credit/);
  assert.ok(f.buttons().every((b) => Buffer.byteLength(b.callback_data) <= 64));
  const second = f.buttons().filter((b) => b.callback_data.startsWith("acct:resetpick:"))[1];
  await f.click(second.callback_data);
  assert.equal(consumes.length, 0);
  assert.match(f.messages.at(-1).text, /되돌릴 수 없습니다/);
  const confirmation = f.messages.at(-1), confirm = f.buttonData("acct:resetconfirm:");
  await f.click(confirm, confirmation);
  assert.equal(consumes.length, 1);
  assert.equal(consumes[0].id, managed.id);
  assert.equal(consumes[0].params.creditId, "OPAQUE:credit/1");
  assert.match(consumes[0].params.idempotencyKey, /^[a-f0-9-]{36}$/);
  assert.match(confirmation.text, /Reset권을 사용했습니다/);
  assert.match(confirmation.html, /사용 가능: <b>1<\/b>/);
  assert.equal(reads.at(-1), managed.id);
  assert.deepEqual(f.r.state.chats, before);
  assert.equal(f.r.threadCache.get("1"), cache);
  assert.equal(f.savedState().accountResetAttempts[managed.id], undefined);
  assert.equal(f.buttonData("acct:reset:", confirmation), `acct:reset:${managed.id}`);
  await f.click(confirm, confirmation);
  assert.equal(consumes.length, 1);
});

test("Reset lists page through server details and count-only accounts offer explicit automatic selection", async (t) => {
  const calls = [];
  let sample = resetUsage(18);
  const f = await fixture(t, { readUsage: async () => sample, consumeCredit: async (_c, id, params) => { calls.push({ id, params }); return { outcome: "nothingToReset" }; } });
  await f.send("/usage");
  await f.click(f.buttonData("acct:reset:"));
  const first = f.messages.at(-1);
  assert.equal(f.buttons().filter((b) => b.callback_data.startsWith("acct:resetpick:")).length, 8);
  await f.click(f.buttons().find((b) => b.text === "▶️").callback_data);
  assert.match(f.messages.at(-1).html, /Reset &lt;9&gt;/);
  await f.click(f.buttons().find((b) => b.text === "▶️").callback_data);
  assert.equal(f.buttons().filter((b) => b.callback_data.startsWith("acct:resetpick:")).length, 2);
  await f.click(f.buttonData("acct:resetpick:", first), first);
  assert.match(f.messages.at(-1).text, /만료/);
  sample = { ...sample, rateLimitResetCredits: { availableCount: 2, credits: null } };
  await f.click("acct:reset:default");
  assert.match(f.buttons().find((b) => b.callback_data.startsWith("acct:resetpick:")).text, /자동 선택/);
  await f.click(f.buttonData("acct:resetpick:"));
  assert.match(f.messages.at(-1).text, /서버가.*1장/);
  await f.click(f.buttonData("acct:resetconfirm:"));
  assert.equal(calls.length, 1);
  assert.equal(Object.hasOwn(calls[0].params, "creditId"), false);
  assert.match(f.messages.at(-1).text, /소모되지 않았습니다/);
});

test("Reset confirmation is bound to the admin, chat, prompt, token and expiry; text does not rename an account", async (t) => {
  let consumed = 0;
  const f = await fixture(t, { readUsage: async () => resetUsage(), consumeCredit: async () => { consumed++; return { outcome: "reset" }; } });
  await f.send("/accounts");
  await f.click("acct:reset:default");
  await f.click(f.buttonData("acct:resetpick:"));
  const confirmation = f.messages.at(-1), data = f.buttonData("acct:resetconfirm:");
  const account = await f.store.get("default");
  await f.send("do not rename this");
  assert.deepEqual(await f.store.get("default"), account);
  assert.equal(f.forwarded.length, 0);
  await f.click(data, confirmation, { userId: 2 });
  await f.click(data, confirmation, { chat: { id: -1, type: "group" } });
  await f.click(data, { ...confirmation, message_id: confirmation.message_id + 999 });
  await f.click("acct:resetconfirm:bad-token", confirmation);
  assert.equal(consumed, 0);
  f.clock.now += 5 * 60_000 + 1;
  await f.click(data, confirmation);
  assert.equal(consumed, 0);
  assert.match(f.messages.at(-1).text, /만료/);
  assert.equal(f.r.state.accountUi["1:1"], undefined);
});

test("cancel and close discard Reset confirmations without consuming credits", async (t) => {
  const f = await fixture(t, { readUsage: async () => resetUsage(), consumeCredit: async () => assert.fail("must not consume") });
  await f.send("/accounts");
  for (const action of ["cancel", "close", "command"]) {
    await f.click("acct:reset:default");
    await f.click(f.buttonData("acct:resetpick:"));
    const message = f.messages.at(-1), confirm = f.buttonData("acct:resetconfirm:");
    if (action === "cancel") await f.click(f.buttonData("acct:cancelui:"));
    if (action === "close") await f.click("ui:close:menu");
    if (action === "command") await f.send("/help");
    await f.click(confirm, message);
    assert.match(f.messages.at(-1).text, /만료/);
    assert.equal(f.r.state.accountUi["1:1"], undefined);
  }
});

test("Reset retries preserve the exact attempt through navigation and a bot restart", async (t) => {
  const calls = [];
  const f = await fixture(t, {
    readUsage: async () => ({ ...resetUsage(), rateLimitResetCredits: { availableCount: 2, credits: null } }),
    consumeCredit: async (_c, id, params) => {
      calls.push({ id, params });
      if (calls.length === 1) throw new Error("network response lost SECRET_SENTINEL");
      return { outcome: "alreadyRedeemed" };
    }
  });
  await f.send("/accounts");
  await f.click("acct:reset:default");
  await f.click(f.buttonData("acct:resetpick:"));
  await f.click(f.buttonData("acct:resetconfirm:"));
  assert.match(f.messages.at(-1).text, /결과가 아직 확인되지/);
  assert.doesNotMatch(JSON.stringify(f.messages), /SECRET_SENTINEL/);
  assert.equal(calls.length, 1);
  await f.click("ui:close:menu");
  const restarted = f.restart();
  await restarted.send("/accounts");
  await restarted.click("acct:reset:default");
  assert.equal(restarted.buttons().filter((b) => b.callback_data.startsWith("acct:resetpick:")).length, 0);
  assert.ok(restarted.buttons().some((b) => b.text.includes("같은 요청 재확인")));
  await restarted.click(restarted.buttonData("acct:resetconfirm:"));
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], calls[1]);
  assert.match(restarted.messages.at(-1).text, /추가로 소모된 사용권은 없습니다/);
  assert.equal(restarted.savedState().accountResetAttempts.default, undefined);
});

test("double Reset confirmation consumes once and every documented result refreshes actual usage", async (t) => {
  for (const [outcome, expected] of [["reset", /Reset권을 사용했습니다/], ["noCredit", /사용 가능한 Reset권이 없습니다/], ["nothingToReset", /소모되지 않았습니다/], ["alreadyRedeemed", /추가로 소모된 사용권은 없습니다/]]) {
    let consumes = 0, reads = 0;
    const f = await fixture(t, { readUsage: async () => { reads++; return resetUsage(); }, consumeCredit: async () => { consumes++; return { outcome }; } });
    await f.send("/accounts");
    await f.click("acct:reset:default");
    await f.click(f.buttonData("acct:resetpick:"));
    const message = f.messages.at(-1), data = f.buttonData("acct:resetconfirm:");
    await Promise.all([f.click(data, message), f.click(data, message)]);
    assert.equal(consumes, 1);
    assert.equal(reads, 2);
    assert.match(message.text, expected);
  }
});

test("known-empty, unavailable, API-key, pending and deleted accounts cannot offer a Reset redemption", async (t) => {
  let sample = resetUsage(0);
  const f = await fixture(t, { readUsage: async () => sample, consumeCredit: async () => assert.fail("must not consume") });
  await f.send("/accounts");
  for (const current of [sample, { ...sample, rateLimitResetCredits: null }, { ...sample, account: { type: "apiKey" } }]) {
    sample = current;
    await f.click("acct:reset:default");
    assert.equal(f.buttons().filter((b) => b.callback_data.startsWith("acct:resetpick:")).length, 0);
    assert.ok(f.buttons().some((b) => b.callback_data === "ui:close:menu"));
  }
  const pending = await f.store.create("Pending");
  await f.click(`acct:reset:${pending.id}`);
  assert.match(f.messages.at(-1).text, /로그인을 완료/);
  await f.store.remove(pending.id);
  await f.click(`acct:reset:${pending.id}`);
  assert.match(f.messages.at(-1).text, /더 이상 등록/);
});

test("Reset success survives a subsequent usage refresh failure without a second consumption", async (t) => {
  let consumes = 0;
  const f = await fixture(t, { readUsage: async () => {
    if (consumes) throw new Error("refresh failed");
    return resetUsage();
  }, consumeCredit: async () => { consumes++; return { outcome: "reset" }; } });
  await f.send("/accounts");
  await f.click("acct:reset:default");
  await f.click(f.buttonData("acct:resetpick:"));
  await f.click(f.buttonData("acct:resetconfirm:"));
  assert.match(f.messages.at(-1).text, /Reset권을 사용했습니다/);
  assert.match(f.messages.at(-1).text, /사용량을 불러오지 못했습니다/);
  assert.equal(f.savedState().accountResetAttempts.default, undefined);
  assert.equal(consumes, 1);
});

test("Reset confirmation fails closed if its pre-request persistence fails", async (t) => {
  const f = await fixture(t, { readUsage: async () => resetUsage(), consumeCredit: async () => assert.fail("must not consume") });
  await f.send("/accounts");
  await f.click("acct:reset:default");
  await f.click(f.buttonData("acct:resetpick:"));
  f.r.saveState = async () => { throw new Error("disk full"); };
  await f.click(f.buttonData("acct:resetconfirm:"));
  assert.match(f.messages.at(-1).text, /disk full/);
});

test("unsubmitted Reset confirmations survive restart but a credit expiring before confirmation cannot be used", async (t) => {
  let consumes = 0, sample = resetUsage(1);
  const f = await fixture(t, { readUsage: async () => sample, consumeCredit: async () => { consumes++; return { outcome: "reset" }; } });
  await f.send("/accounts");
  await f.click("acct:reset:default");
  await f.click(f.buttonData("acct:resetpick:"));
  const prompt = f.messages.at(-1), confirm = f.buttonData("acct:resetconfirm:");
  const restarted = f.restart();
  await restarted.click(confirm, prompt);
  assert.equal(consumes, 1);
  await restarted.send("/accounts");
  sample = resetUsage(1);
  sample.rateLimitResetCredits.credits[0].expiresAt = f.clock.now / 1000 + 10;
  await restarted.click("acct:reset:default");
  await restarted.click(restarted.buttonData("acct:resetpick:"));
  f.clock.now += 11_000;
  await restarted.click(restarted.buttonData("acct:resetconfirm:"));
  assert.equal(consumes, 1);
  assert.equal(restarted.r.state.accountUi["1:1"].kind, "reset-list");
});

test("two administrators cannot consume credits concurrently for the same account", async (t) => {
  let consumes = 0, finish, entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const f = await fixture(t, { readUsage: async () => resetUsage(), consumeCredit: async () => {
    consumes++;
    entered();
    await new Promise((resolve) => { finish = resolve; });
    return { outcome: "reset" };
  } });
  f.r.config.codexAccountAdminUserIds.add("2");
  await f.send("/accounts");
  await f.click("acct:reset:default");
  await f.click(f.buttonData("acct:resetpick:"));
  const first = f.messages.at(-1), firstConfirm = f.buttonData("acct:resetconfirm:");
  const secondUser = { userId: 2, chat: { id: 2, type: "private" } };
  await f.send("/accounts", secondUser);
  await f.click("acct:reset:default", f.messages.at(-1), secondUser);
  await f.click(f.buttonData("acct:resetpick:"), f.messages.at(-1), secondUser);
  const second = f.messages.at(-1), secondConfirm = f.buttonData("acct:resetconfirm:");
  const running = f.click(firstConfirm, first);
  await started;
  try {
    await f.click(secondConfirm, second, secondUser);
    assert.match(f.messages.at(-1).text, /처리 중/);
    assert.equal(consumes, 1);
  } finally { finish(); await running; }
});

test("Reset outcome persistence failure keeps the original attempt for an idempotent retry", async (t) => {
  const calls = [];
  const f = await fixture(t, { readUsage: async () => resetUsage(), consumeCredit: async (_c, _id, params) => {
    calls.push(params);
    return { outcome: calls.length === 1 ? "reset" : "alreadyRedeemed" };
  } });
  await f.send("/accounts");
  await f.click("acct:reset:default");
  await f.click(f.buttonData("acct:resetpick:"));
  const save = f.r.saveState;
  let saves = 0;
  f.r.saveState = async () => { if (++saves === 2) throw new Error("disk full after response"); await save(); };
  await f.click(f.buttonData("acct:resetconfirm:"));
  assert.equal(calls.length, 1);
  assert.equal(f.savedState().accountResetAttempts.default.idempotencyKey, calls[0].idempotencyKey);
  f.r.saveState = save;
  const restarted = f.restart();
  await restarted.send("/accounts");
  await restarted.click("acct:reset:default");
  await restarted.click(restarted.buttonData("acct:resetconfirm:"));
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], calls[1]);
  assert.match(restarted.messages.at(-1).text, /추가로 소모된 사용권은 없습니다/);
});

test("Reset lists and confirmations use all supported languages", async (t) => {
  for (const [language, label] of [["en", "Use this Reset credit"], ["ko", "이 Reset권 사용"], ["zh-tw", "使用此重設券"]]) {
    const f = await fixture(t, { readUsage: async () => resetUsage(), consumeCredit: async () => assert.fail("must not consume") });
    f.r.state.ui.language = language;
    await f.send("/accounts");
    await f.click("acct:reset:default");
    await f.click(f.buttonData("acct:resetpick:"));
    assert.ok(f.buttons().some((button) => button.text.includes(label)));
    assert.doesNotMatch(f.messages.at(-1).text, /reset[A-Z]|usage[A-Z]/);
  }
});

test("main menu usage refreshes the selected account in place and follows later account selection", async (t) => {
  const calls = [];
  const f = await fixture(t, { readUsage: async (_config, id) => { calls.push(id); return usageSample(51 + calls.length); } });
  const account = await f.store.create("<업무 계정>");
  await f.store.update(account.id, { status: "ready" });
  f.r.state.chats["1"].accountId = account.id;
  const chatBefore = { ...f.r.state.chats["1"] };
  await f.send("/menu");
  const panel = f.messages.at(-1);
  const messageCount = f.messages.length;
  await f.click(f.buttonData("acct:usage", panel), panel);
  assert.match(panel.html, /&lt;업무 계정&gt;/);
  assert.match(panel.html, /사용 52% · 남음 <b>48%/);
  assert.ok(f.buttons(panel).some((button) => button.callback_data === "p:main"));
  assert.equal(f.messages.length, messageCount);
  await f.click(f.buttonData("acct:usage", panel), panel);
  assert.match(panel.html, /사용 53% · 남음 <b>47%/);
  assert.equal(f.messages.length, messageCount);
  assert.deepEqual(calls, [account.id, account.id]);
  assert.deepEqual(f.r.state.chats["1"], chatBefore);
  assert.equal(f.apiCalls.filter((call) => call.method === "answerCallbackQuery").length, 2);
  await f.click("acct:use:default", panel);
  await f.click("acct:usage", panel);
  assert.equal(calls.at(-1), "default");
  assert.match(panel.html, /Default/);
  assert.equal(f.forwarded.length, 0);
  assert.equal(f.signIns.length, 0);
});

test("account list and slash usage share the panel, and navigation clears name input", async (t) => {
  const f = await fixture(t, { readUsage: async () => usageSample() });
  await f.send("/accounts");
  await f.click(f.buttonData("acct:usage"));
  assert.match(f.messages.at(-1).html, /Codex · 주간/);
  await f.click(f.buttonData("acct:list"));
  await f.click("acct:rename:default");
  const before = f.apiCalls.filter((call) => call.method === "answerCallbackQuery").length;
  await f.send("/usage@test_bot");
  assert.match(f.messages.at(-1).html, /Codex · 주간/);
  assert.equal(f.apiCalls.filter((call) => call.method === "answerCallbackQuery").length, before);
  assert.equal(f.savedState().accountUi["1:1"], undefined);
  await f.click(f.buttonData("ui:close:menu"));
  assert.equal(f.messages.at(-1).text, "menuClosed");
  assert.deepEqual(f.buttons(), []);
  assert.equal(f.forwarded.length, 0);
});

test("usage commands and callbacks reject foreign users and groups before reading account data", async (t) => {
  const calls = [];
  const f = await fixture(t, { readUsage: async () => { calls.push(true); return usageSample(); } });
  for (const options of [{ userId: 2 }, { userId: 3 }, { chat: { id: -100, type: "supergroup" } }]) {
    await f.send("/usage", options);
    assert.match(f.messages.at(-1).text, /개인 채팅/);
    await f.click("acct:usage", f.messages.at(-1), options);
    assert.match(f.messages.at(-1).text, /개인 채팅/);
    await f.click("acct:usage:default", f.messages.at(-1), options);
    assert.match(f.messages.at(-1).text, /개인 채팅/);
  }
  assert.deepEqual(calls, []);
  assert.equal(f.forwarded.length, 0);
});

test("usage holds an account lease during queries and releases it after success or failure", async (t) => {
  let fail = false;
  const f = await fixture(t, { readUsage: async (_config, id) => {
    await assert.rejects(f.store.remove(id), /running task/);
    if (fail) throw new Error("TOKEN_SENTINEL must not be shown");
    return usageSample();
  } });
  const account = await f.store.create("Saved account");
  await f.store.update(account.id, { status: "ready" });
  f.r.state.chats["1"].accountId = account.id;
  await f.send("/usage");
  const leases = path.join(f.config.codexAccountsDir, "leases", account.id);
  assert.deepEqual(await fs.readdir(leases), []);
  fail = true;
  await f.click("acct:usage");
  assert.match(f.messages.at(-1).text, /불러오지 못했습니다/);
  assert.doesNotMatch(JSON.stringify(f.messages), /TOKEN_SENTINEL/);
  assert.deepEqual(await fs.readdir(leases), []);
  assert.ok(f.buttons().some((button) => button.callback_data === `acct:usage:${account.id}`));
  assert.ok(f.buttons().some((button) => button.callback_data === "ui:close:menu"));
  fail = false;
  await f.click("acct:usage");
  assert.match(f.messages.at(-1).html, /남음 <b>48%/);
  await f.store.remove(account.id);
});

test("pending accounts offer sign-in guidance without querying their credentials", async (t) => {
  let queried = false;
  const f = await fixture(t, { readUsage: async () => { queried = true; return usageSample(); } });
  const account = await f.store.create("Signing in");
  f.r.state.chats["1"].accountId = account.id;
  await f.send("/usage");
  assert.match(f.messages.at(-1).text, /로그인을 완료/);
  assert.equal(queried, false);
  assert.ok(f.buttons().some((button) => button.callback_data === "acct:list"));
  assert.ok(f.buttons().some((button) => button.callback_data === "ui:close:menu"));
});

test("usage Refresh updates reset credit counts and keeps menu navigation", async (t) => {
  let count = 3;
  const f = await fixture(t, { readUsage: async () => ({ ...usageSample(), rateLimitResetCredits: { availableCount: count, credits: null } }) });
  await f.send("/usage");
  const panel = f.messages.at(-1), total = f.messages.length;
  assert.match(panel.html, /사용 가능: <b>3<\/b>/);
  count = 2;
  await f.click(f.buttonData("acct:usage", panel), panel);
  assert.match(panel.html, /사용 가능: <b>2<\/b>/);
  assert.equal(f.messages.length, total);
  assert.ok(f.buttons(panel).some((button) => button.callback_data === "acct:list"));
  assert.ok(f.buttons(panel).some((button) => button.callback_data === "ui:close:menu"));
  assert.equal(f.forwarded.length, 0);
});

test("usage account buttons switch quotas and credits without changing task selection or threads", async (t) => {
  const calls = [];
  const f = await fixture(t, { readUsage: async (_config, id) => {
    calls.push(id);
    return { ...usageSample(id === "default" ? 52 : 10), rateLimitResetCredits: { availableCount: id === "default" ? 3 : 1, credits: [] } };
  } });
  const other = await f.store.create("<다른 계정>");
  await f.store.update(other.id, { status: "ready" });
  f.r.state.chats["1"].accountId = "default";
  f.r.state.chats["1"].threadAccountId = "default";
  f.r.state.chats["1"].accountThreads = { default: "original-thread", [other.id]: "other-thread" };
  const before = JSON.parse(JSON.stringify(f.r.state.chats["1"])), thread = { id: "original-thread" };
  f.r.threadCache.set("1", thread);
  await f.send("/usage");
  const panel = f.messages.at(-1), total = f.messages.length;
  const button = f.buttons(panel).find((item) => item.callback_data === `acct:usage:${other.id}`);
  assert.equal(button.text, "<다른 계정>");
  await f.click(button.callback_data, panel);
  assert.match(panel.html, /조회 계정: <b>&lt;다른 계정&gt;<\/b>/);
  assert.match(panel.html, /사용 10% · 남음 <b>90%/);
  assert.match(panel.html, /사용 가능: <b>1<\/b>/);
  assert.match(panel.text, /작업 계정은 유지/);
  assert.ok(f.buttons(panel).some((item) => item.text === "✅ <다른 계정>"));
  assert.ok(f.buttons(panel).every((item) => Buffer.byteLength(item.callback_data) <= 64));
  const refresh = f.buttons(panel).find((item) => item.text === "🔄 새로고침");
  assert.equal(refresh.callback_data, `acct:usage:${other.id}`);
  await f.click(refresh.callback_data, panel);
  assert.deepEqual(calls, ["default", other.id, other.id]);
  assert.deepEqual(f.r.state.chats["1"], before);
  assert.equal(f.r.threadCache.get("1"), thread);
  assert.equal(f.messages.length, total);
  await f.click("acct:usage:default", panel);
  assert.match(panel.html, /사용 가능: <b>3<\/b>/);
  assert.equal(f.messages.length, total);
  assert.equal(f.forwarded.length, 0);
});

test("account-specific Refresh stays bound across task changes and bot restart", async (t) => {
  const calls = [];
  const f = await fixture(t, { readUsage: async (_config, id) => { calls.push(id); return usageSample(); } });
  const other = await f.store.create("Other");
  await f.store.update(other.id, { status: "ready" });
  await f.send("/usage");
  const panel = f.messages.at(-1);
  const refreshDefault = f.buttons(panel).find((item) => item.text === "🔄 새로고침").callback_data;
  await f.click(`acct:use:${other.id}`, panel);
  await f.click(refreshDefault, panel);
  assert.equal(calls.at(-1), "default");
  assert.equal(f.r.state.chats["1"].accountId, other.id);
  const restarted = f.restart();
  await restarted.click(refreshDefault, panel);
  assert.equal(calls.at(-1), "default");
  assert.equal(restarted.r.state.chats["1"].accountId, other.id);
  await restarted.send("/usage");
  assert.equal(calls.at(-1), other.id);
});

test("deleted or failing usage accounts keep other account buttons usable", async (t) => {
  let fail = false;
  const calls = [];
  const f = await fixture(t, { readUsage: async (_config, id) => {
    calls.push(id);
    if (fail && id !== "default") throw new Error("private failure");
    return usageSample();
  } });
  const other = await f.store.create("Other account");
  await f.store.update(other.id, { status: "ready" });
  await f.send("/usage");
  const panel = f.messages.at(-1);
  fail = true;
  await f.click(`acct:usage:${other.id}`, panel);
  assert.match(panel.text, /불러오지 못했습니다/);
  assert.match(panel.text, /Other account/);
  assert.ok(f.buttons(panel).some((item) => item.callback_data === "acct:usage:default"));
  assert.equal(f.r.state.chats["1"].accountId, undefined);
  await f.store.remove(other.id);
  const previousCalls = calls.length;
  await f.click(`acct:usage:${other.id}`, panel);
  assert.equal(calls.length, previousCalls);
  assert.match(panel.text, /더 이상 등록되어 있지 않은 계정/);
  assert.ok(f.buttons(panel).some((item) => item.callback_data === "acct:usage:default"));
  await f.click("acct:usage:default", panel);
  assert.match(panel.html, /Codex · 주간/);
  await f.click(f.buttonData("ui:close:menu", panel), panel);
  assert.equal(panel.text, "menuClosed");
  assert.deepEqual(f.buttons(panel), []);
});
