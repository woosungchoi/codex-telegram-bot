import test from "node:test";
import assert from "node:assert/strict";
import { workspaceFixture } from "./helpers/workspace_fixture.mjs";

function active(id = "turn", thread = undefined) {
  return { currentText: "Task <unsafe> SECRET", currentPreparedTurn: { id, chatId: 1, requesterUserId: "1", messageThreadId: thread },
    workerJobId: id, nativeProgress: { status: "active", plan: [{ step: "Inspect <script>", status: "inProgress" }], files: ["file.js"], tokenUsage: { last: { inputTokens: 10, outputTokens: 5 }, modelContextWindow: 100 } } };
}
function receipt(f, job, status, chatKey = "1") {
  f.state.worker ||= { deliveries: {} };
  f.state.worker.deliveries[`${chatKey}:${job}`] = { chatKey, jobId: job, deliveryStatus: status };
}
test("one pinned card integrates native controls, finishes separately from delivery and deletes the card after confirmed delivery", async (t) => {
  const f = await workspaceFixture(t); const a = active(); f.r.activeTurns.set("1", a);
  await Promise.all([f.controller.dashboard.tick(), f.controller.dashboard.tick()]);
  const panel = f.state.workspace.panels["1:0"];
  assert.equal(f.messages.length, 1);
  assert.ok(f.buttons().some((b) => b.callback_data.startsWith("panel:inspect:")));
  assert.match(f.messages[0].html, /&lt;script&gt;/);
  assert.doesNotMatch(f.messages[0].html, /SECRET/);
  receipt(f, "turn", "delivery_failed");
  await f.controller.dashboard.recordResult("1", a.currentPreparedTurn, { delivered: false, deliveryPending: true });
  assert.match(f.messages[0].text, /실행 상태: 완료/);
  assert.match(f.messages[0].text, /최종 답변 전송: 실패/);
  assert.equal(panel.pinned, false);
  assert.ok(!f.buttons().some((b) => b.callback_data === "w:stop"));
  f.r.activeTurns.clear(); receipt(f, "turn", "delivery_sent");
  await f.controller.dashboard.tick();
  assert.equal(f.state.workspace.panels["1:0"], undefined);
  assert.equal(f.messages.length, 1);
  const id = panel.messageId;
  f.r.activeTurns.set("1", active("next")); await f.controller.dashboard.tick();
  assert.equal(f.messages.length, 2);
  assert.notEqual(f.state.workspace.panels["1:0"].messageId, id);
  assert.equal(f.apiCalls.filter((c) => c.method === "deleteMessage").length, 1);
});
test("restart reuses a persisted card and does not label an unverified run successful", async (t) => {
  const f = await workspaceFixture(t); f.r.activeTurns.set("1", active());
  await f.controller.dashboard.tick();
  const saved = JSON.parse(JSON.stringify(f.state));
  const f2 = await workspaceFixture(t, { state: saved });
  f2.r.activeTurns.set("1", active()); await f2.controller.dashboard.tick();
  assert.equal(f2.messages.length, 0);
  f2.r.activeTurns.clear(); await f2.controller.dashboard.tick();
  assert.equal(saved.workspace.panels["1:0"].runs[0].status, "unknown");
  assert.equal(saved.workspace.panels["1:0"].runs[0].delivery, "legacy_unknown");
});
test("topic cards remain isolated, disabled panels stay hidden and cancellation never becomes success", async (t) => {
  const f = await workspaceFixture(t);
  const a = active("a", 7); const other = active("b", 8);
  f.r.activeTurns.set("1:7", a); f.r.activeTurns.set("1:8", other);
  await f.controller.dashboard.tick();
  await f.controller.dashboard.recordResult("1:7", a.currentPreparedTurn, { cancelled: true, delivered: false });
  assert.equal(f.state.workspace.panels["1:7"].runs[0].status, "interrupted");
  assert.equal(f.state.workspace.panels["1:8"].pinned, true);
  f.state.workspace.panelPreferences["1:8"] = false;
  await f.controller.dashboard.tick(); await f.controller.dashboard.tick();
  assert.equal(f.state.workspace.panels["1:8"], undefined);
  assert.equal(f.messages.length, 2);
});
test("all controls exist from the first message and keep their identity after worker admission", async (t) => {
  const f = await workspaceFixture(t); const a = active(); a.workerJobId = "";
  f.r.activeTurns.set("1", a); await f.controller.dashboard.tick();
  const initialButtons = f.buttons().map((b) => b.callback_data);
  assert.equal(initialButtons.filter((data) => data.startsWith("panel:")).length, 3);
  a.workerJobId = "turn"; await f.controller.dashboard.tick();
  assert.deepEqual(f.buttons().map((b) => b.callback_data), initialButtons);
  assert.ok(f.buttons().some((b) => b.callback_data.startsWith("panel:")));
  const ctx = { chat: { id: 1 }, callbackQuery: { message: { message_id: f.messages[0].message_id } } };
  assert.equal(await f.controller.dashboard.refresh(ctx, { jobId: "other", chatKey: "1" }), false);
  assert.equal(await f.controller.dashboard.refresh(ctx, { jobId: "turn", chatKey: "1", progress: { status: "waiting" } }), true);
  assert.equal(f.messages.length, 1);
  assert.match(f.messages[0].text, /대기/);
});
test("scheduled job controls resolve only from their exact destination and card", async (t) => {
  const f = await workspaceFixture(t); const a = active("scheduled", 9);
  f.r.activeTurns.set("task:scheduled", a); await f.controller.dashboard.tick();
  const callback = f.buttons()[0].callback_data;
  const ctx = { chat: { id: 1 }, callbackQuery: { message: { message_id: f.messages[0].message_id, message_thread_id: 9 } } };
  const token = callback.split(":").at(-1);
  assert.equal(f.controller.dashboard.resolveJob(ctx, token).chatKey, "task:scheduled");
  ctx.callbackQuery.message.message_thread_id = 8;
  assert.equal(f.controller.dashboard.resolveJob(ctx, token), undefined);
});
test("worker recovery replacement can finish the original requested task", async (t) => {
  const f = await workspaceFixture(t); const original = { id: "old", chatId: 1 };
  f.r.activeTurns.set("1", active("replacement"));
  await f.controller.dashboard.recordResult("1", original, { delivered: true });
  assert.equal(f.state.workspace.panels["1:0"], undefined);
  await f.controller.dashboard.tick();
  assert.equal(f.messages.length, 0);
});
test("a deleted active card is replaced once on the next tick", async (t) => {
  const f = await workspaceFixture(t); f.r.activeTurns.set("1", active());
  await f.controller.dashboard.tick();
  f.r.activeTurns.get("1").currentTurnStartedAt = new Date(f.clock.now).toISOString();
  const originalApi = f.bot.telegram.callApi;
  let missing = true;
  f.bot.telegram.callApi = async (method, payload) => {
    if (method === "editMessageText" && missing) { missing = false; throw new Error("message to edit not found"); }
    return originalApi(method, payload);
  };
  f.clock.now += 10000;
  await f.controller.dashboard.tick(); await f.controller.dashboard.tick(); await f.controller.dashboard.tick();
  assert.equal(f.messages.length, 2);
});
test("deletion failure survives restart and retries without recreating a completed card", async (t) => {
  const f = await workspaceFixture(t); const a = active(); f.r.activeTurns.set("1", a);
  await f.controller.dashboard.tick();
  const originalApi = f.bot.telegram.callApi;
  f.bot.telegram.callApi = async (method, payload) => {
    if (method === "deleteMessage") throw new Error("ETIMEDOUT");
    return originalApi(method, payload);
  };
  receipt(f, "turn", "delivery_sent");
  await f.controller.dashboard.recordResult("1", a.currentPreparedTurn, { delivered: true });
  assert.equal(f.state.workspace.panels["1:0"].cleanupPending, true);
  const restored = await workspaceFixture(t, { state: JSON.parse(JSON.stringify(f.state)) });
  await restored.controller.dashboard.tick();
  assert.equal(restored.state.workspace.panels["1:0"], undefined);
  assert.equal(restored.apiCalls.filter((c) => c.method === "deleteMessage").length, 1);
  assert.equal(restored.messages.length, 0);
});
test("an ambiguous delete which already removed the message resolves on not-found", async (t) => {
  const f = await workspaceFixture(t); const a = active(); f.r.activeTurns.set("1", a);
  await f.controller.dashboard.tick();
  const api = f.bot.telegram.callApi;
  f.bot.telegram.callApi = async (method, payload) => {
    if (method === "deleteMessage") throw new Error("Bad Request: message to delete not found");
    return api(method, payload);
  };
  await f.controller.dashboard.recordResult("1", a.currentPreparedTurn, { delivered: true });
  await f.controller.dashboard.tick();
  assert.equal(f.state.workspace.panels["1:0"], undefined);
  assert.equal(f.messages.length, 1);
});
test("panel callbacks stay in one card, preserve detail during timer refresh, and reject late or foreign clicks", async (t) => {
  const { createNativeControls } = await import("../src/telegram/native_controls.js");
  const { textFor } = await import("../src/i18n.js");
  const f = await workspaceFixture(t); const a = active(); a.workerJobId = ""; f.r.activeTurns.set("1", a);
  await f.controller.dashboard.tick();
  let result = "", inspected = 0; const answers = [];
  const controls = createNativeControls({ getChatKey: () => "1", activeTurns: f.r.activeTurns, deliveries: () => ({}), queue: () => [], steering: {}, text: (k) => textFor("ko", k),
    resolveStatusJob: f.controller.dashboard.resolveJob, refreshStatus: f.controller.dashboard.refresh,
    getClient: () => ({ inspectJob: async (p) => { inspected++; assert.equal(p.userId, "1"); return { jobId: "turn", receipt: "accepted", progress: { files: ["<file>.js"] }, result }; } }) });
  const message = f.messages[0];
  const buttons = f.buttons().slice(0, 3).map((b) => b.callback_data);
  const click = (data, user = 1) => controls.handle({ chat: { id: 1 }, from: { id: user }, callbackQuery: { data, message },
    answerCbQuery: async (v) => answers.push(v), reply: () => assert.fail("extra status message") });
  await click(buttons[0]); assert.match(answers.at(-1), /접수 준비/); assert.equal(inspected, 0);
  a.workerJobId = "turn";
  await click(buttons[1]); assert.match(message.html, /&lt;file&gt;/);
  const detail = message.html; f.clock.now += 10000; await f.controller.dashboard.tick(); assert.equal(message.html, detail);
  await click(buttons[2]); assert.match(answers.at(-1), /결과/); assert.equal(message.html, detail);
  result = "final <answer>"; await click(buttons[2]); assert.match(message.html, /final &lt;answer&gt;/);
  await click(f.buttons().find((b) => b.callback_data.includes(":back:")).callback_data); assert.match(message.html, /실행 상태/);
  await click(buttons[0]); assert.match(message.html, /수신 확인됨/);
  const previous = inspected; await click(buttons[1], 2); assert.equal(inspected, previous); assert.match(answers.at(-1), /권한/);
  await f.controller.dashboard.recordResult("1", a.currentPreparedTurn, { delivered: true });
  await click(buttons[0]); assert.equal(inspected, previous); assert.match(answers.at(-1), /종료/);
  assert.equal(f.messages.length, 1);
});
test("late detail RPC cannot recreate a panel deleted during final delivery", async (t) => {
  const f = await workspaceFixture(t); const a = active(); f.r.activeTurns.set("1", a);
  await f.controller.dashboard.tick();
  const panel = f.state.workspace.panels["1:0"];
  const ctx = { chat: { id: 1 }, from: { id: 1 }, callbackQuery: { message: { message_id: panel.messageId } } };
  const runId = panel.runs[0].id;
  await f.controller.dashboard.recordResult("1", a.currentPreparedTurn, { delivered: true });
  assert.equal(await f.controller.dashboard.refresh(ctx, { jobId: "turn", panelRunId: runId, chatKey: "1", progress: { files: ["late.js"] } }, "files"), false);
  assert.equal(f.messages.length, 1);
  assert.equal(f.state.workspace.panels["1:0"], undefined);
});
test("ready, sending, failed and unknown deliveries remain visible until explicitly confirmed", async (t) => {
  const f = await workspaceFixture(t); const a = active(); f.r.activeTurns.set("1", a);
  await f.controller.dashboard.tick();
  a.dashboardResult = { delivered: false, deliveryPending: true };
  for (const status of ["result_ready", "delivery_sending", "delivery_failed", "legacy_unknown"]) {
    receipt(f, "turn", status); await f.controller.dashboard.tick();
    assert.ok(f.state.workspace.panels["1:0"]);
  }
  assert.equal(f.apiCalls.filter((c) => c.method === "deleteMessage").length, 0);
  receipt(f, "turn", "delivery_sent"); await f.controller.dashboard.tick();
  await f.controller.dashboard.tick(); // Still present in activeTurns: must not recreate.
  assert.equal(f.state.workspace.panels["1:0"], undefined);
  assert.equal(f.messages.length, 1);
});
test("hidden third concurrent task prevents premature cleanup of a shared destination card", async (t) => {
  const f = await workspaceFixture(t);
  for (const id of ["a", "b", "c"]) {
    f.r.activeTurns.set(id, active(id)); receipt(f, id, id === "c" ? "streaming" : "delivery_sent", id);
  }
  await f.controller.dashboard.tick(); assert.ok(f.state.workspace.panels["1:0"]);
  assert.equal(f.apiCalls.filter((c) => c.method === "deleteMessage").length, 0);
  receipt(f, "c", "delivery_sent", "c"); await f.controller.dashboard.tick();
  assert.equal(f.state.workspace.panels["1:0"], undefined);
});

test("input receipt updates automatically, separates unchecked from uncertain and ignores a previous job", async (t) => {
  const f = await workspaceFixture(t); const a = active();
  f.r.activeTurns.set("1", a);
  await f.controller.dashboard.tick();
  assert.match(f.messages[0].text, /입력 전달: 아직 확인하지 않음/);
  assert.doesNotMatch(f.messages[0].text, /확인 불가/);
  a.workerInputReceipt = { jobId: "turn", receipt: "pending" };
  await f.controller.dashboard.tick();
  assert.match(f.messages[0].text, /입력 전달: 수신 확인 대기 중/);
  a.dashboardInspection = { jobId: "turn", receipt: "uncertain", unavailable: true };
  a.workerInputReceipt.receipt = "accepted";
  await f.controller.dashboard.tick();
  assert.match(f.messages[0].text, /입력 전달: 수신 확인됨/);
  assert.equal(f.state.workspace.panels["1:0"].runs[0].inspectionUnavailable, false);
  assert.equal(f.messages.length, 1);
  delete a.dashboardInspection;
  a.workerInputReceipt.receipt = "uncertain";
  await f.controller.dashboard.tick();
  assert.match(f.messages[0].text, /입력 전달: 확인 불가 · 자동 재전송 안 함/);
  a.workerJobId = "replacement";
  a.workerInputReceipt.receipt = "accepted";
  await f.controller.dashboard.tick();
  assert.match(f.messages[0].text, /입력 전달: 아직 확인하지 않음/);
  a.workerInputReceipt = { jobId: "replacement", receipt: "recovered" };
  await f.controller.dashboard.tick();
  assert.match(f.messages[0].text, /입력 전달: 완료 결과 확인됨/);
  assert.ok(f.state.workspace.panels["1:0"]); // Input proof is not final delivery proof.
});
