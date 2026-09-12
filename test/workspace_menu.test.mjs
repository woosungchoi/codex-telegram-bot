import test from "node:test";
import assert from "node:assert/strict";
import { workspaceFixture } from "./helpers/workspace_fixture.mjs";
import { taskChatKey } from "../src/workspace/scheduler.js";
import { createRuntimeKeyboardViews } from "../src/ui/keyboards.js";
import { normalizePendingTurn, serializePendingTurn } from "../src/queue.js";
import { saveRuntimeState } from "../src/runtime/state_store.js";
import { createQueueRuntimeController } from "../src/queue/runtime_controller.js";
import fs from "node:fs/promises";
import path from "node:path";

async function registerTask(f, options = {}) {
  await f.send("/newtask", options); await f.send("Morning check", options); await f.send("Check CI failures", options);
  await f.press("현재 폴더·계정·모델 사용"); await f.press("N분 간격"); await f.send("5", options); await f.press("✅ 저장");
  return Object.values(f.state.workspace.tasks)[0];
}
test("main and tools menus expose all five workspace features", () => {
  const v = createRuntimeKeyboardViews({ text: (k) => k, hasActiveTurn: () => false });
  const actions = v.mainPanelKeyboard("1").reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  for (const key of ["projects", "sessions", "tasks", "dashboard", "mcp"]) assert.ok(actions.includes(`w:${key}`));
  assert.ok(v.toolsKeyboard().reply_markup.inline_keyboard.flat().some((b) => b.callback_data === "w:mcp"));
});
test("projects save presets, rename, favorite, switch and delete without deleting folders", async (t) => {
  const f = await workspaceFixture(t);
  await f.send("/projects"); await f.press("현재 프로젝트 저장"); await f.send("My project");
  const p = Object.values(f.state.workspace.projects)[0][0];
  assert.equal(p.options.model, "model-one");
  await f.press("즐겨찾기"); assert.equal(p.favorite, true);
  await f.press("이름 변경"); await f.send("Renamed"); assert.equal(p.name, "Renamed");
  f.r.getChatState("1").options.model = "changed";
  await f.press("프로젝트 열기"); assert.equal(f.r.getChatState("1").options.model, "model-one");
  assert.equal(f.r.getChatState("1").threadId, undefined);
  await f.press("삭제"); await f.press("✅ 확인");
  assert.equal(Object.values(f.state.workspace.projects)[0].length, 0);
  assert.deepEqual(f.forwarded, []);
});
test("folder browser validates paths and closing input does not register a project", async (t) => {
  const f = await workspaceFixture(t);
  await f.send("/projects"); await f.press("경로 입력"); await f.send("relative/path");
  assert.match(f.messages.at(-1).text, /absolute/);
  await f.send("/cancel"); await f.send("ordinary chat"); assert.deepEqual(f.forwarded, ["ordinary chat"]);
  await f.send("/projects"); await f.press("폴더 찾아보기"); await f.press("이 폴더 선택");
  await f.press("닫기"); assert.equal(Object.values(f.state.workspace.projects)[0].length, 0);
});
test("old, foreign-user and cross-topic buttons cannot mutate state", async (t) => {
  const f = await workspaceFixture(t);
  await f.send("/projects"); await f.press("현재 프로젝트 저장"); await f.send("Project");
  const msg = f.messages.at(-1), data = f.buttons().find((b) => b.text.includes("즐겨찾기")).callback_data;
  await f.click(data, msg, { userId: 2 }); assert.match(f.messages.at(-1).text, /만료/);
  await f.click(data, msg, { threadId: 10 }); assert.match(f.messages.at(-1).text, /만료/);
  assert.equal(Object.values(f.state.workspace.projects)[0][0].favorite, false);
  f.clock.now += 16 * 60_000; await f.click(data, msg); assert.match(f.messages.at(-1).text, /만료/);
});
test("project switching refuses an active turn and preserves the original context", async (t) => {
  const f = await workspaceFixture(t);
  await f.send("/projects"); await f.press("현재 프로젝트 저장"); await f.send("Project");
  f.r.activeTurns.set("1", {}); await f.press("프로젝트 열기");
  assert.equal(f.r.getChatState("1").threadId, "original"); assert.match(f.messages.at(-1).text, /실행 중/);
});
test("session browsing and pagination preserve the account; resume adopts the selected session", async (t) => {
  const f = await workspaceFixture(t);
  await f.send("/sessions"); await f.press("→");
  assert.equal(f.backendCalls.at(-1).args.cursor, "page2");
  assert.equal(f.r.getChatState("1").threadId, "original");
  await f.press("First session"); assert.match(f.messages.at(-1).text, /preview answer/);
  await f.press("이 세션 이어하기"); assert.equal(f.r.getChatState("1").threadId, "session-one");
  assert.equal(f.r.getChatState("1").options.workingDirectory, f.root);
});
test("watching does not resume a session and closing clears the watcher", async (t) => {
  const f = await workspaceFixture(t);
  await f.send("/sessions"); await f.press("First session"); await f.press("실시간 관찰");
  assert.equal(f.state.workspace.flows["1:0:1"].data.kind, "watch");
  assert.equal(f.r.getChatState("1").threadId, "original");
  await f.press("닫기"); assert.equal(f.state.workspace.flows["1:0:1"], undefined);
});
test("active external session cannot be resumed from its card", async (t) => {
  const f = await workspaceFixture(t, { readTail: async () => ({ messages: [], activity: "running" }) });
  await f.send("/sessions"); await f.press("First session"); await f.press("이 세션 이어하기");
  assert.equal(f.r.getChatState("1").threadId, "original");
});
test("task wizard saves a frozen account/options snapshot and supports editing and deletion", async (t) => {
  const f = await workspaceFixture(t); const item = await registerTask(f);
  assert.equal(item.destination.botId, 123); assert.equal(item.owner, "1:0:1");
  assert.equal(item.nextAt, f.clock.now + 300_000);
  await f.press("요청 수정"); await f.send("Check open issues"); await f.press("✅ 저장");
  assert.equal(f.state.workspace.tasks[item.id].prompt, "Check open issues");
  await f.press("삭제"); await f.press("✅ 확인"); assert.equal(f.state.workspace.tasks[item.id], undefined);
});
test("confirmed run is queued once and leaves current chat options and session unchanged", async (t) => {
  const f = await workspaceFixture(t); const item = await registerTask(f);
  f.r.getChatState("1").options.model = "new-model";
  await f.press("지금 실행"); const msg = f.messages.at(-1), data = f.buttons().find((b) => b.text.includes("✅ 확인")).callback_data;
  await f.click(data, msg); await f.click(data, msg);
  assert.equal(f.starts.length, 1); assert.equal(f.queue.get(taskChatKey(item.id)).length, 1);
  assert.equal(f.r.getChatState("1").threadId, "original"); assert.equal(f.r.getChatState("1").options.model, "new-model");
  assert.equal(f.r.getChatState(taskChatKey(item.id)).options.model, "model-one");
  assert.equal(f.saves.some((s) => s.workspace.tasks[item.id]?.run?.id && s.queues?.[taskChatKey(item.id)]?.[0].id === s.workspace.tasks[item.id].run.id), true);
});
test("scheduled tick skips duplicates and pauses tasks when owner loses authorization", async (t) => {
  const f = await workspaceFixture(t); const item = await registerTask(f);
  f.clock.now += 300_000;
  await Promise.all([f.controller.scheduler.tick(), f.controller.scheduler.tick()]);
  assert.equal(f.starts.length, 1);
  await f.controller.scheduler.stopRun(item);
  f.r.config.allowedUserIds.clear(); f.clock.now += 300_000;
  await f.controller.scheduler.tick(); assert.equal(item.enabled, false); assert.match(item.error, /authorized/);
});
test("scheduler never executes for a different originating bot", async (t) => {
  const f = await workspaceFixture(t); const item = await registerTask(f);
  item.destination.botId = 999; f.clock.now += 300_000;
  await f.controller.scheduler.tick(); assert.equal(f.starts.length, 0); assert.equal(item.enabled, false);
});
test("MCP mutation requires an idle account and uses the exact selected server", async (t) => {
  const f = await workspaceFixture(t);
  await f.send("/mcp"); await f.press("test-server"); await f.press("끄기");
  const call = f.backendCalls.find((c) => c.method === "setMcpEnabled");
  assert.deepEqual(call.args.slice(2), ["test-server", false, "v1"]);
  await f.press("test-server"); f.r.activeTurns.set("1", {}); await f.press("켜기");
  assert.equal(f.backendCalls.filter((c) => c.method === "setMcpEnabled").length, 1);
});
test("MCP is restricted to account administrators", async (t) => {
  const f = await workspaceFixture(t); await f.send("/mcp", { userId: 2 });
  assert.match(f.messages.at(-1).text, /계정 관리자/); assert.equal(f.backendCalls.length, 0);
});
test("dashboard pins once, updates, and removes only its own pin when idle", async (t) => {
  const f = await workspaceFixture(t);
  f.r.activeTurns.set("1", { currentText: "Task", currentTurnStartedAt: new Date(f.clock.now).toISOString(), currentPreparedTurn: { chatId: 1 } });
  await f.controller.dashboard.tick(); await f.controller.dashboard.tick();
  assert.equal(f.apiCalls.filter((c) => c.method === "pinChatMessage").length, 1);
  const panel = f.state.workspace.panels["1:0"];
  f.r.activeTurns.delete("1"); await f.controller.dashboard.tick();
  assert.equal(f.apiCalls.find((c) => c.method === "unpinChatMessage").payload.message_id, panel.messageId);
  assert.equal(f.state.workspace.panels["1:0"], undefined);
});

test("switching to the account menu clears a workspace input flow before the account router", async (t) => {
  const f = await workspaceFixture(t);
  await f.send("/projects"); await f.press("현재 프로젝트 저장");
  await f.send("/accounts"); await f.send("ordinary chat");
  assert.deepEqual(f.forwarded, ["ordinary chat"]);
  assert.equal(f.state.workspace.flows["1:0:1"], undefined);
});

test("scheduled queue serialization retains account and exact chat/topic across restart", async (t) => {
  const f = await workspaceFixture(t);
  const item = await registerTask(f, { threadId: 55 });
  await f.controller.scheduler.run(item, { manual: true });
  const key = taskChatKey(item.id);
  const saved = serializePendingTurn(f.queue.get(key)[0]);
  const hydrated = normalizePendingTurn(JSON.parse(JSON.stringify(saved)), { chatKey: key });
  assert.equal(hydrated.chatId, 1); assert.equal(hydrated.messageThreadId, 55);
  assert.equal(hydrated.accountId, "default"); assert.equal(hydrated.chatType, "private");
  const f2 = await workspaceFixture(t, { state: JSON.parse(JSON.stringify(f.state)) });
  await f2.controller.scheduler.tick(); assert.equal(f2.starts.length, 0);
});

test("restart reconciliation recognizes a delivered result and never executes it again", async (t) => {
  const f = await workspaceFixture(t); const item = await registerTask(f);
  await f.controller.scheduler.run(item, { manual: true }); await f.r.clearPendingTurns(taskChatKey(item.id));
  f.state.worker = { deliveries: { receipt: { chatKey: taskChatKey(item.id), jobId: item.run.id, deliveryStatus: "delivery_sent" } } };
  await f.controller.scheduler.reconcile(item);
  assert.equal(item.run.status, "completed"); assert.equal(f.starts.length, 1);
});

test("a failed or cancelled scheduled turn is recorded separately from successful delivery", async (t) => {
  const f = await workspaceFixture(t); const item = await registerTask(f);
  await f.controller.scheduler.run(item, { manual: true });
  await f.controller.scheduler.recordResult(taskChatKey(item.id), { id: item.run.id }, { delivered: false, cancelled: true });
  assert.equal(item.run.status, "cancelled");
});

test("dashboard falls back to an ordinary card when pinning is unavailable", async (t) => {
  const f = await workspaceFixture(t);
  const callApi = f.bot.telegram.callApi;
  f.bot.telegram.callApi = async (method, payload) => {
    if (method === "pinChatMessage") throw new Error("not enough rights");
    return callApi(method, payload);
  };
  f.r.activeTurns.set("1", { currentPreparedTurn: { chatId: 1 }, currentText: "work" });
  await f.controller.dashboard.tick();
  assert.equal(f.state.workspace.panels["1:0"].pinFailed, true);
  assert.match(f.messages.at(-1).text, /고정 권한/);
});

test("concurrent state saves preserve invocation order and durable workspace state", async (t) => {
  const f = await workspaceFixture(t);
  const file = path.join(f.root, "runtime-state.json");
  await Promise.all(Array.from({ length: 15 }, (_, revision) => saveRuntimeState(file, { revision, workspace: { tasks: {} } })));
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).revision, 14);
});

test("persisted queue draining reconstructs the scheduled run's real Telegram destination", async () => {
  const prepared = { id: "job", chatKey: "scheduled:test", chatId: -10042, messageThreadId: 55, inputText: "check" };
  const contexts = [];
  const controller = createQueueRuntimeController({
    state: { queues: {} }, activeTurns: new Map(), pendingTurns: new Map([[prepared.chatKey, [prepared]]]), sideTurns: new Map(),
    settings: { maxPendingAgeSeconds: () => 0 }, chats: { get: () => ({}) }, persistence: { save: async () => {} },
    telegram: { createSyntheticContext: (meta) => { contexts.push(meta); return { chat: { id: meta.chatId } }; } },
    turns: { runPreparedQueue: async () => {} }
  });
  assert.equal(await controller.startQueueDrainIfIdle(prepared.chatKey), true);
  assert.equal(contexts[0].chatId, -10042); assert.equal(contexts[0].messageThreadId, 55);
});

test("capacity deferral still reconciles later completed tasks to release slots", async (t) => {
  const f = await workspaceFixture(t); const item = await registerTask(f);
  f.state.worker = { deliveries: {} };
  for (const id of ["second", "third", "fourth"]) {
    f.state.workspace.tasks[id] = { ...item, id, enabled: false, run: { id: `${id}-job`, status: "running", startedAt: f.clock.now } };
    f.state.worker.deliveries[id] = { chatKey: taskChatKey(id), jobId: `${id}-job`, deliveryStatus: "delivery_sent" };
  }
  f.clock.now += 300_000;
  await f.controller.scheduler.tick();
  assert.equal(f.starts.length, 0);
  assert.equal(f.state.workspace.tasks.fourth.run.status, "completed");
  await f.controller.scheduler.tick(); assert.equal(f.starts.length, 1);
});
