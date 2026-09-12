import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { workspaceFixture } from "./helpers/workspace_fixture.mjs";
import { authorizeTelegramUpdate } from "../src/security.js";
import { telegramChatKey, telegramReplyExtraFromMeta } from "../src/telegram/context.js";
import { registerTelegramMiddleware } from "../src/telegram/message_router.js";
import { forumState, forumTopicKey, forumTopicUrl } from "../src/forum/store.js";
import { hydratePendingQueues, serializePendingTurn } from "../src/queue.js";
import { telegramCommands } from "../src/telegram/command_menu.js";

const GROUP = -1001234567;
async function fixture(t, opts = {}) {
  let topicSeq = 20;
  const f = await workspaceFixture(t, {
    ...opts,
    api: async (method, payload) => {
      const result = await opts.api?.(method, payload);
      if (result !== undefined) return result;
      if (method === "getChat") return { id: GROUP, type: "supergroup", is_forum: true };
      if (method === "getChatMember") return { status: "administrator", can_manage_topics: true };
      if (method === "createForumTopic") return { message_thread_id: ++topicSeq, name: payload.name };
    },
    configure: (r) => {
      registerTelegramMiddleware({ bot: r.bot, config: r.config, authorize: authorizeTelegramUpdate,
        logger: { warn() {} },
        telegram: { replyHtml: r.replyHtml, summarizeError: (error) => ({ description: error.message }) }
      });
      r.bot.catch((error) => { throw error; });
      opts.configure?.(r);
    }
  });
  const send = (value, extra = {}) => f.send(value, { chatId: GROUP, chatType: "supergroup", isForum: true, threadId: 1, ...extra });
  const ctx = (threadId = 1, userId = 1) => ({ chat: { id: GROUP, type: "supergroup", is_forum: true },
    from: { id: userId }, message: { message_id: 90, message_thread_id: threadId } });
  const add = async (name = "App", accountId = "default") => {
    const cwd = path.join(f.root, name); await fs.mkdir(cwd, { recursive: true });
    const preset = { id: name.toLowerCase(), name, cwd, accountId, options: { workingDirectory: cwd, model: "project-model", modelReasoningEffort: "high" } };
    const state = f.state.workspace;
    (state.projects["1:0:1"] ||= []).push(preset);
    return preset;
  };
  const create = async (name = "App") => {
    const selected = await add(name);
    return f.controller.forum.service.create(ctx(), name, selected);
  };
  return { ...f, send, sendPrivate: f.send, ctx, add, create,
    forum: f.controller.forum, group: () => f.state.forum.groups[String(GROUP)] };
}

test("forum commands are discoverable and private chats show setup instructions", async (t) => {
  const f = await fixture(t);
  assert.ok(telegramCommands("ko").some((x) => x.command === "topics"));
  assert.ok(telegramCommands("ko").some((x) => x.command === "forum_setup"));
  await f.sendPrivate("/topics");
  assert.match(f.messages.at(-1).text, /BotFather/);
  await f.press("개인 대화 토픽 설정");
  assert.equal(Object.keys(f.state.forum.groups).length, 0);
  assert.equal(f.apiCalls.filter((x) => x.method === "createForumTopic").length, 0);
});

test("setup checks permissions, creates AI Chat once, and keeps General separate", async (t) => {
  const f = await fixture(t);
  await f.send("/forum_setup");
  await f.send("/forum_setup");
  assert.equal(f.apiCalls.filter((x) => x.method === "createForumTopic").length, 1);
  assert.equal(f.group().topics[1].role, "manager");
  assert.equal(f.group().topics[21].role, "workspace");
  assert.equal(f.group().topics[21].cwd, f.root);
  assert.equal(f.r.getChatKey(f.ctx()), String(GROUP));
  assert.equal(f.r.getChatKey(f.ctx(21)), `${GROUP}:topic:21`);
  assert.match(f.messages.at(-1).text, /포럼 설정 완료/);
});

test("missing topic permission and Topics-disabled groups cannot initialize", async (t) => {
  for (const fail of ["rights", "topics"]) {
    const f = await fixture(t, { api: async (method) => {
      if (fail === "rights" && method === "getChatMember") return { status: "member" };
      if (fail === "topics" && method === "getChat") return { is_forum: false };
    } });
    await f.send("/forum_setup");
    assert.equal(f.group(), undefined);
    assert.equal(f.apiCalls.filter((x) => x.method === "createForumTopic").length, 0);
  }
});

test("project topic wizard imports own private presets and isolates folders, models and threads", async (t) => {
  const f = await fixture(t);
  const a = await f.add("App"), z = await f.add("Other");
  await f.send("/forum_setup");
  await f.press("프로젝트 토픽 만들기");
  await f.press("App");
  await f.send("App topic");
  const first = Object.values(f.group().topics).find((x) => x.name === "App topic");
  assert.equal(first.cwd, a.cwd);
  assert.equal(f.r.getChatState(`${GROUP}:topic:${first.id}`).options.model, "project-model");
  assert.ok(f.buttons().some((x) => x.url === forumTopicUrl(f.group(), first.id)));
  const second = await f.forum.service.create(f.ctx(), "Other topic", z);
  const key1 = forumTopicKey(f.group(), first.id), key2 = forumTopicKey(f.group(), second.id);
  f.r.getChatState(key1).threadId = "thread-one";
  f.r.getChatState(key2).threadId = "thread-two";
  await f.send("work first", { threadId: first.id });
  await f.send("work second", { threadId: second.id });
  assert.deepEqual(f.forwarded, ["work first", "work second"]);
  assert.equal(f.r.getChatState(key1).threadId, "thread-one");
  assert.equal(f.r.getChatState(key2).threadId, "thread-two");
  delete f.state.chats[key1];
  await f.send("after forget", { threadId: first.id });
  assert.equal(f.r.getChatState(key1).options.workingDirectory, a.cwd);
  assert.equal(f.r.getChatState(key1).threadId, undefined);
  assert.equal(f.r.getChatState(key2).threadId, "thread-two");
});

test("binding uses real paths, rejects duplicates and preserves a busy topic", async (t) => {
  const f = await fixture(t);
  await f.send("/forum_setup");
  const first = await f.create();
  const alias = path.join(f.root, "alias"); await fs.symlink(first.cwd, alias);
  await assert.rejects(f.forum.service.create(f.ctx(), "Duplicate", { cwd: alias, accountId: "default" }), /already connected/);
  assert.equal(f.apiCalls.filter((x) => x.method === "createForumTopic").length, 2);
  const key = forumTopicKey(f.group(), first.id);
  f.r.activeTurns.set(key, {});
  const replacement = await f.add("Replacement");
  await assert.rejects(f.forum.service.bind(f.ctx(), first.id, replacement), /미완료 작업/);
  assert.equal(first.cwd, path.join(f.root, "App"));
  f.r.activeTurns.delete(key);
  await f.forum.service.bind(f.ctx(), first.id, replacement);
  assert.equal(f.r.getChatState(key).options.workingDirectory, replacement.cwd);
});

test("new user topics auto-bind exact names only; unknown topics cannot execute", async (t) => {
  const f = await fixture(t);
  const project = await f.add("Exact App");
  await f.send("/forum_setup");
  await f.send("", { threadId: 40, service: { forum_topic_created: { name: "exact app" } } });
  assert.equal(f.group().topics[40].cwd, project.cwd);
  await f.send("", { threadId: 41, service: { forum_topic_created: { name: "Exact" } } });
  assert.equal(f.group().topics[41].cwd, undefined);
  await f.send("do work", { threadId: 41 });
  await f.send("/not_a_command", { threadId: 41 });
  await f.send("/new", { threadId: 41 });
  assert.equal(f.forwarded.length, 0);
  await f.press("프로젝트 연결"); await f.press("폴더 경로 입력");
  const other = await f.add("Folder");
  await f.send(other.cwd, { threadId: 41 });
  assert.equal(f.group().topics[41].cwd, other.cwd);
});

test("topic lifecycle changes bypass a pending menu input and preserve its next text submission", async (t) => {
  const f = await fixture(t);
  await f.send("/forum_setup");
  await f.send("/projects", { threadId: 21 });
  await f.press("현재 프로젝트 저장");
  const key = `${GROUP}:21:1`, flow = globalThis.structuredClone(f.state.workspace.flows[key]);
  const count = f.messages.length;
  await f.send("", { threadId: 21, service: { forum_topic_edited: { name: "Renamed topic" } } });
  assert.equal(f.group().topics[21].name, "Renamed topic");
  await f.send("", { threadId: 21, service: { forum_topic_closed: {} } });
  assert.equal(f.group().topics[21].closed, true);
  await f.send("", { threadId: 21, service: { forum_topic_reopened: {} } });
  assert.equal(f.group().topics[21].closed, false);
  assert.equal(f.messages.length, count);
  assert.deepEqual(f.state.workspace.flows[key], flow);
  await f.send("Saved after service events", { threadId: 21 });
  assert.equal(f.state.workspace.projects[key][0].name, "Saved after service events");
  assert.deepEqual(f.forwarded, []);
});

test("General prompts dispatch once through buttons; results and notices use distinct destinations", async (t) => {
  const f = await fixture(t);
  await f.send("/forum_setup"); const topic = await f.create();
  await f.send("Fix login");
  const choice = f.messages.at(-1), button = f.buttons(choice).find((x) => x.text === "App");
  await Promise.all([f.click(button.callback_data, choice), f.click(button.callback_data, choice)]);
  const list = Object.values(f.state.forum.jobs);
  assert.equal(list.length, 1);
  const job = list[0], prepared = f.queue.get(job.targetKey)[0];
  assert.equal(job.origin.chatId, GROUP);
  assert.equal(job.origin.messageThreadId, undefined);
  assert.equal(job.origin.botId, 123);
  assert.equal(prepared.messageThreadId, topic.id);
  assert.equal(prepared.chatId, GROUP);
  assert.equal(prepared.inputText, "persona\nFix login");
  assert.equal(f.forwarded.length, 0);
  await f.forum.jobs.beforeTurn(job.targetKey, prepared);
  assert.equal(job.status, "running");
  await f.forum.jobs.recordResult(job.targetKey, prepared, { delivered: true, threadId: "completed-thread" });
  assert.equal(job.status, "completed"); assert.equal(job.report, "sent");
  assert.equal(f.messages.at(-1).chat.id, GROUP);
  assert.equal(f.messages.at(-1).message_thread_id, undefined);
  assert.match(f.messages.at(-1).text, /프로젝트 작업 결과/);
  assert.equal(f.buttons().at(0).url, forumTopicUrl(f.group(), topic.id));
  await assert.rejects(f.forum.jobs.beforeTurn(job.targetKey, prepared), /already finished/);
  await f.forum.jobs.recordResult(job.targetKey, prepared, { delivered: false });
  assert.equal(job.status, "completed");
  const count = f.messages.length;
  await f.forum.jobs.tick(); assert.equal(f.messages.length, count);
  await f.send("/some/folder needs review");
  assert.equal(f.forwarded.length, 0);
  assert.ok(f.buttons().some((button) => button.text === "App"));
});

test("dispatch from AI Chat and queue hydration preserve the target and originating topic", async (t) => {
  const f = await fixture(t);
  await f.send("/forum_setup"); const topic = await f.create();
  await f.send("/dispatch #22 | Review the tests", { threadId: 21 });
  const job = Object.values(f.state.forum.jobs)[0], prepared = f.queue.get(job.targetKey)[0];
  assert.equal(job.origin.messageThreadId, 21);
  const hydrated = hydratePendingQueues({ [job.targetKey]: [serializePendingTurn(prepared)] }, { now: new Date(f.clock.now), maxAgeSeconds: 86400 });
  const restored = hydrated.pending.get(job.targetKey)[0];
  assert.equal(restored.messageThreadId, topic.id); assert.equal(restored.accountId, "default");
  assert.equal(restored.kind, "forum");
  await f.forum.jobs.recordResult(job.targetKey, { ...restored, id: "recovered", progressTurnId: job.id }, { delivered: true });
  assert.equal(f.messages.at(-1).message_thread_id, 21);
  assert.equal(f.starts.length, 1);
});

test("queued jobs recheck bot, owner, target allowlist and binding before running", async (t) => {
  const f = await fixture(t);
  await f.send("/forum_setup"); const topic = await f.create();
  const job = await f.forum.jobs.dispatch(f.ctx(), topic.id, "Bound request"), prepared = f.queue.get(job.targetKey)[0];
  f.bot.botInfo.id = 456;
  await assert.rejects(f.forum.jobs.beforeTurn(job.targetKey, prepared), /authorized|match/);
  f.bot.botInfo.id = 123; f.r.config.allowedUserIds.delete("1");
  await assert.rejects(f.forum.jobs.beforeTurn(job.targetKey, prepared), /authorized/);
  f.r.config.allowedUserIds.add("1"); f.r.config.allowedThreadIds = new Set(["1"]);
  await assert.rejects(f.forum.jobs.beforeTurn(job.targetKey, prepared), /authorized/);
  f.r.config.allowedThreadIds.clear(); topic.bindingId = "different";
  await assert.rejects(f.forum.jobs.beforeTurn(job.targetKey, prepared), /binding changed/);
});

test("completion delivery failures expose an explicit resend without repeating work", async (t) => {
  const f = await fixture(t);
  await f.send("/forum_setup"); const topic = await f.create();
  const job = await f.forum.jobs.dispatch(f.ctx(), topic.id, "One execution"), prepared = f.queue.get(job.targetKey)[0];
  const originalReply = f.r.replyHtml;
  f.r.replyHtml = async () => { throw new Error("connection reset SECRET"); };
  await f.forum.jobs.recordResult(job.targetKey, prepared, { delivered: true });
  assert.equal(job.report, "unknown"); assert.ok(!job.reportError.includes("SECRET"));
  f.r.replyHtml = originalReply;
  const count = f.messages.length;
  await f.forum.jobs.tick(); assert.equal(f.messages.length, count);
  await f.forum.jobs.report(job, { manual: true });
  assert.equal(job.report, "sent"); assert.equal(f.starts.length, 1);
});

test("an explicitly recovered failed job reports its later successful outcome", async (t) => {
  const f = await fixture(t);
  await f.send("/forum_setup"); const topic = await f.create();
  const job = await f.forum.jobs.dispatch(f.ctx(), topic.id, "Recover this work"), prepared = f.queue.get(job.targetKey)[0];
  await f.forum.jobs.recordResult(job.targetKey, prepared, { delivered: false });
  assert.equal(job.report, "sent"); assert.equal(job.status, "failed");
  const oldReport = job.reportMessageId;
  await f.forum.jobs.beforeTurn(job.targetKey, prepared);
  await f.forum.jobs.recordResult(job.targetKey, prepared, { delivered: true });
  assert.equal(job.status, "completed"); assert.equal(job.report, "sent");
  assert.notEqual(job.reportMessageId, oldReport);
});

test("reconciliation recognizes delivered, cancelled and ambiguous sends without re-execution", async (t) => {
  const f = await fixture(t);
  await f.send("/forum_setup"); const topic = await f.create();
  const job = await f.forum.jobs.dispatch(f.ctx(), topic.id, "Resume receipt");
  f.queue.clear(); f.clock.now += 180_000;
  f.state.worker = { deliveries: { done: { chatKey: job.targetKey, jobId: job.id, deliveryStatus: "delivery_sending" } } };
  await f.forum.jobs.tick(); assert.equal(job.status, "delivery_pending");
  f.state.worker.deliveries.done.deliveryStatus = "delivery_sent";
  await f.forum.jobs.tick(); assert.equal(job.status, "completed"); assert.equal(job.report, "sent");
  job.report = "sending";
  await f.forum.jobs.tick(); assert.equal(job.report, "unknown");
  const next = await f.forum.jobs.dispatch(f.ctx(), topic.id, "Removed from queue");
  f.queue.clear(); f.clock.now += 180_000;
  await f.forum.jobs.tick(); assert.equal(next.status, "interrupted");
  assert.equal(f.starts.length, 2);
});

test("disconnect and topic close require idle state and keep files and other topics", async (t) => {
  const f = await fixture(t);
  await f.send("/forum_setup"); const topic = await f.create();
  await f.forum.service.update(f.ctx(), topic.id, "close"); assert.equal(topic.closed, true);
  await assert.rejects(f.forum.jobs.dispatch(f.ctx(), topic.id, "Closed"));
  await f.forum.service.update(f.ctx(), topic.id, "reopen"); assert.equal(topic.closed, false);
  const cwd = topic.cwd;
  await f.forum.service.update(f.ctx(), topic.id, "unbind");
  assert.equal(topic.cwd, undefined); assert.ok((await fs.stat(cwd)).isDirectory());
  assert.equal(Object.keys(f.group().topics).length, 3);
  await f.send("do work", { threadId: topic.id }); assert.equal(f.forwarded.length, 0);
});

test("restricted thread lists do not silently create unapproved topics", async (t) => {
  const f = await fixture(t, { configure: (r) => { r.config.allowedThreadIds = new Set(["1", "40"]); } });
  await f.send("/forum_setup"); assert.equal(f.group().aiTopicId, undefined);
  const p = await f.add();
  await assert.rejects(f.forum.service.create(f.ctx(), "App", p), /ALLOWED_THREAD_IDS/);
  await f.send("", { threadId: 40, service: { forum_topic_created: { name: "App" } } });
  assert.equal(f.group().topics[40].cwd, p.cwd);
});

test("foreign users and stale cross-topic callbacks cannot send a job", async (t) => {
  const f = await fixture(t);
  await f.send("/forum_setup"); await f.create();
  await f.send("Only once");
  const msg = f.messages.at(-1), button = f.buttons(msg).find((x) => x.text === "App");
  await f.click(button.callback_data, msg, { userId: 2 });
  await f.click(button.callback_data, msg, { threadId: 21 });
  assert.equal(Object.keys(forumState(f.state).jobs).length, 0);
  await f.send("/topics"); await f.click(button.callback_data, msg);
  assert.equal(f.starts.length, 0);
});

test("topic keys preserve private chats and General; General replies omit topic 1", () => {
  assert.equal(telegramChatKey({ chat: { id: 1, type: "private" } }), "1");
  assert.equal(telegramChatKey({ chat: { id: 1, type: "private" }, message: { message_thread_id: 1 } }), "1:topic:1");
  const callback = { chat: { id: GROUP, type: "supergroup" }, callbackQuery: { message: { message_thread_id: 31 } } };
  assert.equal(telegramChatKey(callback), `${GROUP}:topic:31`);
  assert.deepEqual(telegramReplyExtraFromMeta({ chatType: "supergroup", messageThreadId: 1 }), {});
  assert.equal(telegramReplyExtraFromMeta({ chatType: "private", messageThreadId: 1 }).message_thread_id, 1);
});

test("topic dashboard includes new-session turns before prepared metadata is available", async (t) => {
  const f = await fixture(t);
  f.r.activeTurns.set(`${GROUP}:topic:40`, {});
  assert.equal(f.controller.dashboard.activeFor({ chatId: GROUP, messageThreadId: 40 }).length, 1);
  assert.equal(f.controller.dashboard.activeFor({ chatId: GROUP, messageThreadId: 41 }).length, 0);
});
