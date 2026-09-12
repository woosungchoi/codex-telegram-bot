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
  const controller = registerAccountCommands(r, { store: storage.store, signIn, readUsage: options.readUsage, now: () => storage.clock.now });
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
  assert.ok(f.buttons().some((button) => button.callback_data === "acct:usage"));
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
