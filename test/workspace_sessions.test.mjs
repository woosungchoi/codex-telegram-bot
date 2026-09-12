import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { readSessionRequest, sessionRequest, sessionTitle, sessionButtonLabel } from "../src/workspace/session_labels.js";
import { createWorkspaceBackend } from "../src/workspace/backend.js";
import { accountFixture } from "./helpers/accounts_fixture.mjs";
import { workspaceFixture } from "./helpers/workspace_fixture.mjs";

const styled = (text) => `<style_instruction>\n응답 스타일 지침: 같은 문구\n</style_instruction>\n\n${text}`;
const message = (role, text, extra = {}) => JSON.stringify({ type: "response_item", payload: {
  type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }], ...extra
} });

test("session titles show the current request instead of style and replied-message context", () => {
  const input = styled("Use the following replied-to Telegram message as context.\n\n<replied_message>Wrong title</replied_message>\n<current_message>로그인 오류를 수정해 주세요.</current_message>");
  assert.equal(sessionRequest(input), "로그인 오류를 수정해 주세요.");
  assert.equal(sessionRequest(styled("## Update\nfix the login form")), "Update fix the login form");
  assert.equal(sessionRequest("Keep <custom_tag> in this example"), "Keep <custom_tag> in this example");
});

test("bootstrap and instruction-only messages never become session task titles", () => {
  for (const input of [
    "새 Telegram Codex 세션을 시작합니다. 이 메시지에는 짧게 준비 완료라고만 답하세요.",
    "Start a new Telegram Codex session. Reply only with a short ready confirmation.",
    "開始新的 Telegram Codex session。只用一句簡短確認回覆已就緒。",
    "<environment_context>cwd, date, permissions</environment_context>",
    "# AGENTS.md instructions for /workspace\n<INSTRUCTIONS>rules</INSTRUCTIONS>",
    "# AGENTS.md instructions\n<INSTRUCTIONS>rules</INSTRUCTIONS>",
    "<style_instruction>truncated boilerplate", "<turn_aborted>Interrupted by user</turn_aborted>"
  ]) assert.equal(sessionRequest(styled(input)), "");
});

test("known image and side-reply wrappers expose the requested task", () => {
  const image = "Use the built-in image generation tool, not the API-key fallback CLI.\nCreate exactly 1 final image file(s).\n\nRequest:\nDraw a red fox";
  assert.equal(sessionRequest(image), "Draw a red fox");
  assert.equal(sessionRequest(image.split("\nRequest:")[0]), "");
  const side = "This is a side reply while the main Telegram Codex turn continues.\nAnswer the user directly. Avoid file changes or write commands.\n\n";
  assert.equal(sessionRequest(side + styled("진행 상황을 알려줘")), "진행 상황을 알려줘");
});

test("explicit names win and titles collapse control characters safely", () => {
  assert.equal(sessionTitle({ name: "Saved name", preview: "Old preview" }, "Task from log"), "Saved name");
  assert.equal(sessionTitle({ name: "  ", preview: styled("Actual request") }), "Actual request");
  assert.equal(sessionTitle({ displayTitle: "Task from log", preview: styled("Fallback") }), "Task from log");
  assert.equal(sessionRequest("Fix\n\tlogin\u202e today"), "Fix login today");
});

test("bounded log title reads skip bootstrap, tools, assistant text and image payloads", async (t) => {
  const { root } = await accountFixture(t);
  const file = path.join(root, "session.jsonl");
  const log = [
    message("developer", "SECRET_RULES"), message("user", "# AGENTS.md instructions for /repo\nRules"),
    message("user", styled("새 Telegram Codex 세션을 시작합니다. 이 메시지에는 짧게 준비 완료라고만 답하세요.")),
    message("assistant", "SECRET_REASONING", { channel: "analysis" }),
    JSON.stringify({ type: "response_item", payload: { type: "function_call_output", output: "SECRET_TOOL" } }),
    message("user", "", { content: [{ type: "input_image", image_url: "SECRET_IMAGE" }] }),
    message("user", styled("Fix payment validation")), message("user", "Later request")
  ].join("\n");
  await fs.writeFile(file, log);
  assert.equal(await readSessionRequest(file, root), "Fix payment validation");
  assert.equal(await fs.readFile(file, "utf8"), log);
});

test("oversized or malformed log records allow a bounded tail fallback", async (t) => {
  const { root } = await accountFixture(t);
  const file = path.join(root, "session.jsonl");
  await fs.writeFile(file, "malformed\n" + message("assistant", "x".repeat(2 * 1024 * 1024)) + "\n" +
    JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: styled("Investigate the failure") } }));
  assert.equal(await readSessionRequest(file, root), "Investigate the failure");
});

test("session title reads reject outside-account paths and symlinks", async (t) => {
  const { root } = await accountFixture(t);
  const account = path.join(root, "sessions"); await fs.mkdir(account);
  const outside = path.join(root, "outside.jsonl"); await fs.writeFile(outside, message("user", "PRIVATE"));
  const link = path.join(account, "linked.jsonl"); await fs.symlink(outside, link);
  await assert.rejects(readSessionRequest(outside, account), /outside/);
  await assert.rejects(readSessionRequest(link, account), /outside/);
  const directory = path.join(account, "directory.jsonl"); await fs.mkdir(directory);
  assert.equal(await readSessionRequest(directory, account), "");
});

test("list/read enrich titles without modifying sessions or losing account and folder filters", async (t) => {
  const { config, root, store } = await accountFixture(t);
  const account = await store.create("other");
  const sessionsDir = path.join(config.codexAccountsDir, "profiles", account.id, "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });
  const file = path.join(sessionsDir, "task.jsonl");
  await fs.writeFile(file, message("user", styled("Start a new Telegram Codex session.")) + "\n" + message("user", styled("Fix the actual task")));
  const rows = [
    { id: "first", name: null, path: file, preview: styled("Start a new Telegram Codex session.") },
    { id: "missing", path: path.join(root, "missing.jsonl"), preview: styled("Fallback task") },
    { id: "named", name: "My saved name", path: file },
    { id: "empty", preview: "<style_instruction>partial" }
  ];
  const calls = [];
  const backend = createWorkspaceBackend(config, { connect: async () => ({ close: async () => {}, request: async (method, args) => {
    calls.push({ method, args }); return { data: rows, nextCursor: "next", thread: rows[0] };
  } }) });
  const result = await backend.listSessions(account.id, { cwd: root, query: "needle", cursor: "before" });
  assert.deepEqual(result.data.map((s) => s.displayTitle), ["Fix the actual task", "Fallback task", "My saved name", ""]);
  assert.equal(result.nextCursor, "next"); assert.equal(calls[0].args.cwd, root);
  assert.equal(calls[0].args.searchTerm, "needle"); assert.equal(calls[0].args.cursor, "before");
  assert.equal(rows[0].displayTitle, undefined);
  assert.equal((await backend.readSession(account.id, "first")).displayTitle, "Fix the actual task");
  assert.deepEqual(calls.map((c) => c.method), ["thread/list", "thread/read"]);
  // The default account must not read the managed account's log.
  assert.equal((await backend.listSessions("default")).data[0].displayTitle, "");
});

test("buttons retain distinguishing ID suffixes, timezone dates and valid emoji within 64 characters", () => {
  const session = { id: "01a0940f-692c-7e53-9023-7a29f75559fb", cwd: "/repo/project", updatedAt: Date.parse("2026-09-12T16:00:00Z") / 1000 };
  const label = sessionButtonLabel(session, "🦊".repeat(90), { timeZone: "Asia/Seoul", showFolder: true });
  assert.match(label, /^09\/13 · f75559fb · project · /); assert.ok(label.length <= 64);
  assert.doesNotMatch(label, /[\ud800-\udbff](?![\udc00-\udfff])/);
  const other = sessionButtonLabel({ ...session, id: "01a0940f-692c-7e53-9023-7a29aaaaaaaa" }, "🦊".repeat(90));
  assert.notEqual(label, other);
  assert.match(sessionButtonLabel(session, "Task", { timeZone: "invalid/timezone" }), /^09\/12/);
  assert.match(sessionButtonLabel({ id: "id", updatedAt: 1e20 }, "Task"), /^—/);
});

test("session scope, search and page survive refresh, cards, watching and account navigation", async (t) => {
  const f = await workspaceFixture(t);
  const other = await f.store.create("Other account");
  await f.send("/sessions");
  assert.equal(f.backendCalls.at(-1).args.cwd, f.root);
  assert.match(f.messages.at(-1).text, /현재 프로젝트/);
  await f.press("검색"); await f.send("needle"); await f.press("새로고침");
  assert.deepEqual(f.backendCalls.at(-1).args, { cwd: f.root, query: "needle", cursor: null });
  await f.press("→"); await f.press("First session"); await f.press("실시간 관찰"); await f.press("관찰 중지"); await f.press("뒤로");
  assert.deepEqual(f.backendCalls.at(-1).args, { cwd: f.root, query: "needle", cursor: "page2" });
  await f.press("←"); assert.equal(f.backendCalls.at(-1).args.cursor, null);
  await f.press("전체 기록");
  assert.deepEqual(f.backendCalls.at(-1).args, { cwd: null, query: "needle", cursor: null });
  await f.press("Other account");
  assert.equal(f.backendCalls.at(-1).id, other.id); assert.equal(f.backendCalls.at(-1).args.cwd, null);
  await f.press("새로고침"); assert.equal(f.backendCalls.at(-1).args.query, "needle");
  await f.press("현재 프로젝트"); assert.equal(f.backendCalls.at(-1).args.cwd, f.root);
  await f.press("검색 초기화"); assert.equal(f.backendCalls.at(-1).args.query, "");
  assert.equal(f.r.getChatState("1").threadId, "original"); assert.equal(f.r.getChatState("1").accountId, "default");
});

test("similar previews have distinct redacted buttons and an untitled fallback", async (t) => {
  const f = await workspaceFixture(t);
  f.sessions.splice(0, 1, ...["aaaa0001", "aaaa0002", "aaaa0003"].map((id, i) => ({ id, cwd: f.root,
    preview: i === 2 ? "<style_instruction>partial" : styled("SECRET 로그인 오류 수정"), updatedAt: f.clock.now / 1000 })));
  await f.send("/sessions");
  const labels = f.buttons().filter((b) => /aaaa000[123]/.test(b.text)).map((b) => b.text);
  assert.equal(labels.length, 3); assert.equal(new Set(labels).size, 3);
  assert.match(labels[0], /\[redacted\] 로그인 오류 수정/); assert.match(labels[2], /제목 없는 세션/);
  assert.ok(labels.every((s) => !s.includes("style_instruction") && !s.includes("SECRET")));
});

test("private and group topic session lists use each topic's current folder", async (t) => {
  const f = await workspaceFixture(t);
  const folder = path.join(f.root, "topic-project");
  f.r.getChatState("1:topic:7").options.workingDirectory = folder;
  await f.send("/sessions", { threadId: 7 }); assert.equal(f.backendCalls.at(-1).args.cwd, folder);
  await f.send("/sessions"); assert.equal(f.backendCalls.at(-1).args.cwd, f.root);
  f.r.getChatState("-1007:topic:8").options.workingDirectory = folder;
  await f.send("/sessions", { chatId: -1007, chatType: "supergroup", isForum: true, threadId: 8 });
  assert.equal(f.backendCalls.at(-1).args.cwd, folder);
});
