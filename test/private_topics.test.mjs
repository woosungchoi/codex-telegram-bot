import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { workspaceFixture } from "./helpers/workspace_fixture.mjs";
import { registerTelegramMiddleware } from "../src/telegram/message_router.js";
import { authorizeTelegramUpdate } from "../src/security.js";
import { registerAccountCommands } from "../src/accounts/controller.js";
import { forumDestination, forumRootTopicId, forumTopicId, forumTopicKey, forumTopicUrl } from "../src/forum/store.js";
import { hydratePendingQueues, serializePendingTurn } from "../src/queue.js";
import { createTelegramRuntimeContext } from "../src/telegram/runtime_context.js";

async function fixture(t, options = {}) {
  const mode = { enabled: options.enabled !== false };
  let seq = 0;
  const f = await workspaceFixture(t, {
    state: options.state,
    api: async (method, payload) => {
      if (method === "getMe") return { id: 123, is_bot: true, username: "test_bot", first_name: "Bot",
        has_topics_enabled: mode.enabled, allows_users_to_create_topics: false };
      if (method === "createForumTopic") {
        assert.ok(mode.enabled);
        return { message_thread_id: ++seq, name: payload.name };
      }
      if (["getChat", "getChatMember", "closeForumTopic", "reopenForumTopic", "deleteForumTopic"].includes(method)) {
        throw new Error(`Unexpected group/destructive API in a private chat: ${method}`);
      }
    },
    configure: (r) => {
      options.configure?.(r);
      registerTelegramMiddleware({ bot: r.bot, config: r.config, authorize: authorizeTelegramUpdate,
        logger: { warn() {} }, telegram: { replyHtml: r.replyHtml, summarizeError: (error) => ({ description: error.message }) } });
      if (options.accounts) {
        const accounts = registerAccountCommands(r);
        t.after(() => accounts.close());
      }
      r.bot.catch((error) => { throw error; });
    }
  });
  const ctx = (id = 0, userId = 1, chatId = 1) => ({ chat: { id: chatId, type: "private" }, from: { id: userId },
    message: { message_id: 99, message_thread_id: id || undefined } });
  const add = async (name = "App", accountId = "default") => {
    const cwd = path.join(f.root, name);
    await fs.mkdir(cwd, { recursive: true });
    const preset = { id: name.toLowerCase(), name, cwd, accountId,
      options: { workingDirectory: cwd, model: "project-model", modelReasoningEffort: "high" } };
    (f.state.workspace.projects["1:0:1"] ||= []).push(preset);
    return preset;
  };
  const forum = f.controller.forum;
  const create = async (name = "App", accountId = "default") => forum.service.create(ctx(), name, await add(name, accountId));
  return { ...f, mode, ctx, add, create, forum, group: () => f.state.forum.groups["1"] };
}

test("private topic setup guides BotFather and refreshes enabled state without a restart", async (t) => {
  const f = await fixture(t, { enabled: false });
  await f.send("/topics");
  const setupMenu = f.messages.at(-1);
  assert.match(f.messages.at(-1).text, /BotFather/);
  assert.ok(f.buttons().some((item) => item.url === "https://t.me/BotFather"));
  await f.press("개인 대화 토픽 설정");
  assert.equal(f.group(), undefined);
  assert.equal(f.apiCalls.filter((item) => item.method === "createForumTopic").length, 0);
  f.mode.enabled = true;
  // The same pending setup button can be retried after enabling Topics.
  await f.click(f.buttons(setupMenu).find((item) => item.text.includes("개인 대화 토픽 설정")).callback_data, setupMenu);
  assert.equal(f.group().chatType, "private");
  assert.equal(f.group().ownerId, 1);
  assert.match(setupMenu.text, /개인 대화 토픽 설정 완료/);
  assert.equal(f.apiCalls.filter((item) => item.method === "getMe").length, 2);
  assert.equal(f.apiCalls.filter((item) => item.method === "createForumTopic").length, 0);
});

test("private setup preserves existing root and current-topic settings and sessions", async (t) => {
  const f = await fixture(t);
  f.r.getChatState("1").options.model = "root-model";
  f.r.getChatState("1:topic:7").options.model = "existing-model";
  const root = globalThis.structuredClone(f.r.getChatState("1"));
  const current = globalThis.structuredClone(f.r.getChatState("1:topic:7"));
  await f.send("/forum_setup", { threadId: 7 });
  await f.send("/forum_setup", { threadId: 7 });
  assert.equal(f.group().topics[0].role, "workspace");
  assert.equal(f.group().topics[7].role, "workspace");
  assert.deepEqual(f.r.getChatState("1"), root);
  assert.deepEqual(f.r.getChatState("1:topic:7"), current);
  await f.send("continue existing conversation", { threadId: 7 });
  assert.deepEqual(f.forwarded, ["continue existing conversation"]);
  assert.ok(!f.apiCalls.some((item) => ["getChat", "getChatMember", "createForumTopic"].includes(item.method)));
});

test("private project wizard creates real topic 1 and isolates folders, accounts, sessions and input", async (t) => {
  const f = await fixture(t);
  const account = await f.store.create("Project account");
  await f.store.update(account.id, { status: "ready" });
  const app = await f.add("App", account.id);
  await f.send("/forum_setup");
  await f.press("프로젝트 토픽 만들기");
  await f.press("App");
  await f.send("Private project");
  const topic = f.group().topics[1], key = forumTopicKey(f.group(), 1);
  assert.equal(topic.cwd, app.cwd);
  assert.equal(key, "1:topic:1");
  assert.equal(forumTopicKey(f.group(), 0), "1");
  assert.equal(f.r.getChatState(key).accountId, account.id);
  assert.equal(f.r.getChatState(key).options.model, "project-model");
  assert.equal(f.r.getChatState("1").threadId, "original");
  assert.equal(forumTopicUrl(f.group(), 1), null);
  assert.match(f.messages.at(-1).text, /Telegram 토픽 목록/);
  assert.ok(!f.buttons().some((item) => item.url?.includes("t.me/c/")));
  const second = await f.create("Second");
  f.r.getChatState(key).threadId = "project-session";
  f.r.getChatState(forumTopicKey(f.group(), second.id)).threadId = "second-session";
  await f.send("project work", { threadId: 1 });
  await f.send("second work", { threadId: second.id });
  await f.send("root work");
  assert.deepEqual(f.forwarded, ["project work", "second work", "root work"]);
  assert.equal(f.r.getChatState(key).threadId, "project-session");
  assert.equal(f.r.getChatState("1").threadId, "original");
  assert.equal(f.r.getChatState("1").accountId, "default");
});

test("private topic bindings survive state reload and reconstruct deleted preferences in topic 1", async (t) => {
  const f = await fixture(t);
  await f.send("/forum_setup");
  const topic = await f.create();
  const state = JSON.parse(JSON.stringify(f.state));
  delete state.chats["1:topic:1"];
  const restarted = await fixture(t, { state });
  await restarted.send("restored project", { threadId: 1 });
  assert.equal(restarted.r.getChatState("1:topic:1").options.workingDirectory, topic.cwd);
  assert.equal(restarted.r.getChatState("1:topic:1").destination.chatType, "private");
  assert.equal(restarted.r.getChatState("1:topic:1").destination.messageThreadId, 1);
  assert.equal(restarted.r.getChatState("1").threadId, "original");
  assert.deepEqual(restarted.forwarded, ["restored project"]);
});

test("private dispatch, persisted queue and completion keep the exact root or topic destination", async (t) => {
  const f = await fixture(t);
  await f.send("/forum_setup");
  await f.create("Target");
  const source = await f.create("Source");
  for (const origin of [0, source.id]) {
    const job = await f.forum.jobs.dispatch(f.ctx(origin), 1, `Request from ${origin}`);
    const prepared = f.queue.get("1:topic:1").at(-1);
    assert.equal(prepared.chatType, "private");
    assert.equal(prepared.messageThreadId, 1);
    assert.equal(job.origin.chatType, "private");
    assert.equal(job.origin.messageThreadId, origin || undefined);
    const { pending: queues } = hydratePendingQueues({ "1:topic:1": [serializePendingTurn(prepared)] }, { now: new Date(f.clock.now), maxAgeSeconds: 86400 });
    assert.equal(queues.get("1:topic:1")[0].messageThreadId, 1);
    assert.equal(queues.get("1:topic:1")[0].chatType, "private");
    await f.forum.jobs.beforeTurn("1:topic:1", prepared);
    await f.forum.jobs.recordResult("1:topic:1", prepared, { delivered: true });
    assert.equal(job.report, "sent");
    assert.equal(f.messages.at(-1).chat.type, "private");
    assert.equal(f.messages.at(-1).chat.id, 1);
    assert.equal(f.messages.at(-1).message_thread_id, origin || undefined);
  }
});

test("private destinations and synthetic replies preserve topic 1 while legacy group General omits it", async () => {
  const privateChat = { chatId: 42, chatType: "private", botId: 123 };
  const legacyGroup = { chatId: -1001234, botId: 123 };
  assert.equal(forumRootTopicId(privateChat), 0);
  assert.equal(forumRootTopicId(legacyGroup), 1);
  assert.equal(forumTopicId({ chat: { id: 42, type: "private" }, message: {} }), 0);
  assert.equal(forumDestination(privateChat, 1).messageThreadId, 1);
  assert.equal(forumDestination(legacyGroup, 1).messageThreadId, undefined);
  const calls = [];
  const bot = { botInfo: { id: 123 }, telegram: { sendMessage: async (...args) => calls.push(args) } };
  const runtime = createTelegramRuntimeContext({ bot, chats: { get: () => ({}) } });
  const ctx = runtime.createSyntheticCtx({ ...forumDestination(privateChat, 1), originMessageId: 55 });
  await ctx.reply("result");
  assert.equal(ctx.chat.type, "private");
  assert.deepEqual(calls, [[42, "result", { message_thread_id: 1, reply_parameters: { message_id: 55 } }]]);
});

test("private projects enforce owner, bot identity, chat and thread allowlists", async (t) => {
  const f = await fixture(t);
  await f.send("/forum_setup");
  const topic = await f.create();
  assert.throws(() => f.forum.service.authorize(2, f.group(), 1), /another user/);
  await f.send("/topics", { threadId: 1 });
  const menu = f.messages.at(-1);
  await f.click(f.buttons(menu)[0].callback_data, menu, { userId: 2 });
  assert.equal(f.messages.at(-1), menu);
  assert.throws(() => f.forum.service.authorize(1, { ...f.group(), botId: 999 }, 1), /authorized/);
  f.r.config.allowedChatIds = new Set(["2"]);
  await assert.rejects(f.forum.service.bind(f.ctx(), 1, topic.preset), /authorized/);
  f.r.config.allowedChatIds = new Set(["1"]);
  f.r.config.allowedThreadIds = new Set(["1"]);
  assert.doesNotThrow(() => f.forum.service.authorize(1, f.group(), 1));
  assert.throws(() => f.forum.service.authorize(1, f.group(), 0), /authorized/);
  assert.throws(() => f.forum.service.authorize(1, f.group(), 2), /authorized/);
  await assert.rejects(f.forum.service.create(f.ctx(1), "Not allowed", topic.preset), /ALLOWED_THREAD_IDS/);
});

test("private jobs reject changed owner or altered origin before execution and delivery", async (t) => {
  const f = await fixture(t);
  await f.send("/forum_setup");
  await f.create();
  const job = await f.forum.jobs.dispatch(f.ctx(), 1, "Private job");
  const prepared = f.queue.get("1:topic:1")[0];
  f.group().ownerId = 2;
  await assert.rejects(f.forum.jobs.beforeTurn("1:topic:1", prepared), /another user/);
  assert.throws(() => f.forum.jobs.validateDelivery("1:topic:1", prepared), /another user/);
  f.group().ownerId = 1;
  job.origin.chatType = "supergroup";
  await assert.rejects(f.forum.jobs.beforeTurn("1:topic:1", prepared), /originating/);
  assert.equal(job.status, "queued");
});

test("private pause/resume prevents new work, respects busy topic 1 and never calls native close or delete", async (t) => {
  const f = await fixture(t);
  await f.send("/forum_setup");
  const topic = await f.create();
  f.r.activeTurns.set("1:topic:1", {});
  await assert.rejects(f.forum.service.update(f.ctx(), 1, "close"), /미완료 작업/);
  f.r.activeTurns.delete("1:topic:1");
  f.r.activeTurns.set("1", {});
  await f.send("/topics", { threadId: 1 });
  await f.press("📍 현재 토픽");
  await f.press("작업 일시정지");
  assert.match(f.messages.at(-1).text, /대화 기록은 보존/);
  await f.press("✅ 확인");
  assert.equal(topic.closed, true);
  await f.send("blocked work", { threadId: 1 });
  await f.send("/new", { threadId: 1 });
  assert.deepEqual(f.forwarded, []);
  await assert.rejects(f.forum.jobs.dispatch(f.ctx(), 1, "blocked dispatch"), /프로젝트/);
  await f.press("작업 재개");
  assert.equal(topic.closed, false);
  await f.send("resumed work", { threadId: 1 });
  assert.deepEqual(f.forwarded, ["resumed work"]);
  assert.ok((await fs.stat(topic.cwd)).isDirectory());
  assert.ok(!f.apiCalls.some((item) => /closeForumTopic|reopenForumTopic|deleteForumTopic/.test(item.method)));
});

test("manual private topics auto-bind exact own project names and keep lifecycle events out of name prompts", async (t) => {
  const f = await fixture(t, { accounts: true });
  await f.send("/forum_setup");
  const preset = await f.add("Exact App");
  await f.send("", { threadId: 7, service: { forum_topic_created: { name: "exact app" } } });
  assert.equal(f.group().topics[7].cwd, preset.cwd);
  await f.send("", { threadId: 8, service: { forum_topic_created: { name: "Other" } } });
  assert.equal(f.group().topics[8].cwd, undefined);
  await f.send("unbound", { threadId: 8 });
  assert.deepEqual(f.forwarded, []);
  await f.send("/accounts", { threadId: 7 });
  await f.click("acct:rename:default");
  const count = f.messages.length;
  await f.send("", { threadId: 7, service: { forum_topic_edited: { name: "Edited App" } } });
  assert.equal(f.messages.length, count);
  assert.equal(f.group().topics[7].name, "Edited App");
  await f.send("Renamed account", { threadId: 7 });
  assert.equal((await f.store.get("default")).label, "Renamed account");
});

test("account input and callbacks cannot consume the pending name in a different private topic", async (t) => {
  const f = await fixture(t, { accounts: true });
  await f.send("/forum_setup");
  await f.create("First");
  await f.create("Second");
  await f.send("/accounts", { threadId: 1 });
  await f.click("acct:rename:default");
  const prompt = f.messages.at(-1), flow = globalThis.structuredClone(f.state.accountUi["1:topic:1:1"]);
  await f.send("ordinary second-topic text", { threadId: 2 });
  await f.send("/topics", { threadId: 2 });
  assert.deepEqual(f.state.accountUi["1:topic:1:1"], flow);
  assert.deepEqual(f.forwarded, ["ordinary second-topic text"]);
  assert.equal((await f.store.get("default")).label, "Default");
  const cancel = f.buttons(prompt).find((item) => item.callback_data.startsWith("acct:cancelui:"));
  await f.click(cancel.callback_data, prompt, { threadId: 2 });
  assert.deepEqual(f.state.accountUi["1:topic:1:1"], flow);
  await f.send("Correct topic name", { threadId: 1 });
  assert.equal((await f.store.get("default")).label, "Correct topic name");
  assert.equal(f.state.accountUi["1:topic:1:1"], undefined);
});
