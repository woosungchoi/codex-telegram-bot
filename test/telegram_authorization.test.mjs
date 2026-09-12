import test from "node:test";
import assert from "node:assert/strict";
import { Telegraf } from "telegraf";
import { authorizeTelegramUpdate } from "../src/security.js";
import { registerTelegramMiddleware } from "../src/telegram/message_router.js";
import { registerAccountCommands } from "../src/accounts/controller.js";
import { textFor } from "../src/i18n.js";
import { workspaceFixture } from "./helpers/workspace_fixture.mjs";

function installAuthorization(r, logs = []) {
  registerTelegramMiddleware({
    bot: r.bot, config: r.config, authorize: authorizeTelegramUpdate,
    logger: { warn: (...args) => logs.push(args) },
    telegram: { replyHtml: r.replyHtml, summarizeError: (error) => ({ description: error.message }),
      text: (key) => textFor(r.state?.ui?.language || r.config.telegramLanguage, key) }
  });
}

function fixture(config = {}, { failApi } = {}) {
  const bot = new Telegraf("123:test");
  bot.botInfo = { id: 123, is_bot: true, first_name: "Bot", username: "test_bot" };
  const calls = [], logs = [], forwarded = [];
  let seq = 1;
  const api = async (method, payload) => {
    calls.push({ method, payload });
    if (method === failApi) throw new Error("Telegram request expired or blocked");
    return true;
  };
  bot.telegram.callApi = api;
  bot.use((ctx, next) => { ctx.telegram.callApi = api; return next(); });
  installAuthorization({ bot, config: { allowedUserIds: new Set(["1"]), telegramLanguage: "ko", ...config },
    replyHtml: (ctx, text) => ctx.reply(text) }, logs);
  bot.catch((error) => { throw error; });
  bot.use((ctx) => { forwarded.push(ctx.update); });
  const send = ({ from = { id: 1, is_bot: false, first_name: "User" },
    chat = { id: 1, type: "private" }, data, ...content } = {}) => {
    const message = { message_id: ++seq, date: 0, chat, from, ...content };
    return bot.handleUpdate({ update_id: ++seq, ...(data === undefined ? { message } : {
      callback_query: { id: `cb-${seq}`, from, chat_instance: "test", data,
        message: { ...message, from: bot.botInfo } }
    }) });
  };
  return { bot, calls, logs, forwarded, send };
}

test("dashboard pins and other service notifications do not reply or reach command/input routes", async () => {
  const f = fixture();
  for (const from of [f.bot.botInfo, { id: 1, is_bot: false }, { id: 99, is_bot: false }]) {
    await f.send({ from, pinned_message: { message_id: 99, from: { id: 1 }, text: "Private dashboard" } });
  }
  for (const event of [{ new_chat_members: [{ id: 1 }] }, { left_chat_member: { id: 2 } },
    { new_chat_title: "Changed" }, { video_chat_ended: { duration: 10 } }]) {
    await f.send({ chat: { id: -100, type: "supergroup" }, ...event });
  }
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.logs, []);
  assert.deepEqual(f.forwarded, []);
});

test("authorized text, attachments and replies retain routing, including General topic normalization", async () => {
  const f = fixture();
  for (const content of [{ text: "/menu" }, { photo: [{ file_id: "photo" }] }, { document: { file_id: "pdf" } },
    { text: "Please investigate", reply_to_message: { pinned_message: {}, text: "Unauthorized." } }]) {
    await f.send(content);
  }
  await f.send({ text: "/topics", chat: { id: -100, type: "supergroup", is_forum: true }, message_thread_id: 1 });
  assert.equal(f.forwarded.length, 5);
  assert.equal(f.forwarded.at(-1).message.message_thread_id, undefined);
  assert.deepEqual(f.calls, []);
});

test("denied private messages explain the user restriction and audit only routing metadata", async () => {
  const f = fixture();
  await f.send({ from: { id: 99, is_bot: false }, text: "SECRET_INPUT", reply_to_message: { from: { id: 1 } } });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].method, "sendMessage");
  assert.equal(f.calls[0].payload.text, textFor("ko", "telegramUnauthorizedUser"));
  assert.deepEqual(f.logs[0][1], { reason: "unauthorized_user", updateId: 3, updateType: "message",
    userId: 99, chatId: 1, messageThreadId: null });
  assert.doesNotMatch(JSON.stringify(f.logs), /SECRET_INPUT|reply_to_message/);
  assert.deepEqual(f.forwarded, []);
});

test("unknown group users, bot senders and anonymous service identities cannot trigger commands or chat spam", async () => {
  const f = fixture();
  const chat = { id: -100, type: "supergroup" };
  await f.send({ chat, from: { id: 99, is_bot: false }, text: "/menu" });
  await f.send({ from: f.bot.botInfo, text: "/menu" });
  await f.send({ chat, sender_chat: chat, from: { id: 1087968824, is_bot: true }, text: "/menu" });
  assert.equal(f.logs.length, 1);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.forwarded, []);
});

test("chat and topic allowlists still reject allowed users with distinct notices", async () => {
  for (const [config, content, reason, key] of [
    [{ allowedChatIds: new Set(["-200"]) }, { chat: { id: -100, type: "supergroup" } }, "disallowed_chat", "telegramDisallowedChat"],
    [{ allowedThreadIds: new Set(["8"]) }, { chat: { id: -100, type: "supergroup", is_forum: true }, message_thread_id: 7 }, "disallowed_thread", "telegramDisallowedThread"]
  ]) {
    const f = fixture(config);
    await f.send({ text: "/menu", ...content });
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].method, "sendMessage");
    assert.equal(f.calls[0].payload.text, textFor("ko", key));
    assert.equal(f.logs[0][1].reason, reason);
    assert.deepEqual(f.forwarded, []);
  }
});

test("denied buttons use an alert once without logging callback data or sending chat messages", async () => {
  const f = fixture();
  await f.send({ from: { id: 99, is_bot: false }, data: "SECRET_CALLBACK" });
  assert.deepEqual(f.calls, [{ method: "answerCallbackQuery", payload: {
    callback_query_id: "cb-3", text: textFor("ko", "telegramUnauthorizedUser"), show_alert: true
  } }]);
  assert.equal(f.logs[0][1].updateType, "callback_query");
  assert.doesNotMatch(JSON.stringify(f.logs), /SECRET_CALLBACK|cb-3/);
  assert.deepEqual(f.forwarded, []);
});

test("expired denial alerts and blocked private replies do not cause secondary Telegram bot errors", async () => {
  for (const [failApi, content] of [["answerCallbackQuery", { data: "old:button" }], ["sendMessage", { text: "/menu" }]]) {
    const f = fixture({}, { failApi });
    await f.send({ from: { id: 99, is_bot: false }, ...content });
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.forwarded, []);
  }
});

test("forum lifecycle updates must pass user, chat and topic authorization", async () => {
  const chat = { id: -100, type: "supergroup", is_forum: true };
  const f = fixture({ allowedChatIds: new Set(["-100"]), allowedThreadIds: new Set(["7"]) });
  for (const name of ["forum_topic_created", "forum_topic_edited", "forum_topic_closed", "forum_topic_reopened"]) {
    const event = { chat, message_thread_id: 7, [name]: { name: "Topic" } };
    await f.send(event);
    await f.send({ ...event, from: { id: 99, is_bot: false } });
    await f.send({ ...event, chat: { ...chat, id: -200 } });
    await f.send({ ...event, message_thread_id: 8 });
  }
  assert.equal(f.forwarded.length, 4);
  assert.deepEqual(f.calls, []);
});

test("service notifications preserve an open project or account name prompt", async (t) => {
  const f = await workspaceFixture(t, { configure: (r) => {
    installAuthorization(r);
    const accounts = registerAccountCommands(r);
    t.after(() => accounts.close());
  } });
  await f.send("/projects");
  await f.press("현재 프로젝트 저장");
  const prompt = f.messages.at(-1), flow = globalThis.structuredClone(f.state.workspace.flows["1:0:1"]);
  await f.send("", { service: { pinned_message: prompt } });
  assert.equal(f.messages.at(-1), prompt);
  assert.deepEqual(f.state.workspace.flows["1:0:1"], flow);
  await f.send("Project after pin");
  assert.equal(f.state.workspace.projects["1:0:1"][0].name, "Project after pin");
  await f.send("/accounts");
  await f.click("acct:rename:default");
  const accountPrompt = f.messages.at(-1), accountFlow = globalThis.structuredClone(f.state.accountUi["1:1"]);
  await f.send("", { service: { pinned_message: accountPrompt } });
  assert.equal(f.messages.at(-1), accountPrompt);
  assert.deepEqual(f.state.accountUi["1:1"], accountFlow);
  await f.send("Account after pin");
  assert.equal((await f.store.get("default")).label, "Account after pin");
  assert.deepEqual(f.forwarded, []);
});
