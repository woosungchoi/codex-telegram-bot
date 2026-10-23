import { normalizeNotify } from "../src/recovery/restart.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { authorizeTelegramUpdate } from "../src/security.js";
import { readTelegramAccessConfig } from "../src/config/telegram.js";
import { assertStoredRequest, guardTelegramContext, provenanceFields } from "../src/authorization.js";
import { serializePendingTurn, normalizePendingTurn } from "../src/queue.js";
import { recoveryCandidateFromSnapshot } from "../src/recovery/state.js";
import { createRecoveryTurn } from "../src/recovery/startup.js";
import { registerSessionOwner, ownsSession, assertSessionOwner } from "../src/codex/session_owners.js";
import { createCodexThread } from "../src/codex/thread_factory.js";
import { downloadAttachment } from "../src/telegram/download.js";
import { acquireUploadQuota } from "../src/telegram/upload_quota.js";
import { prepareTurnArtifacts, turnArtifactOptions } from "../src/telegram/turn_artifacts.js";
import { extractTelegramPhotoArtifacts, validatedPhotoContents } from "../src/telegram/attachments.js";
import { createDashboardController } from "../src/workspace/dashboard_controller.js";
import { dependencyGraphDigest, validateDependencyLock } from "../src/maintenance/update_dependencies.js";
import { requirePackageApproval } from "../scripts/publish_package_update.mjs";
import { checksPassed, REQUIRED_CHECKS, manifestAllowed, lockfileAllowed, actionRefsOnly } from "../scripts/dependency-pr-policy.mjs";

const config = () => ({ telegramBotToken: "123:fixture", allowedUserIds: new Set(["7", "8"]), allowedChatIds: new Set(["-1001", "-1002"]), allowedTopicBindings: new Set([JSON.stringify(["-1001", "17"])]) });
const record = () => ({ authorizationVersion: 1, botId: "123", requesterUserId: "7", accountId: "default", chatType: "supergroup", isForum: true, chatId: -1001, messageThreadId: 17, chatKey: "-1001:topic:17", id: "turn-a", inputText: "fixture" });
async function temp(t) { const root = await fs.mkdtemp(path.join(os.tmpdir(), "security12-")); t.after(() => fs.rm(root, { recursive: true, force: true })); return root; }

for (const callback of [false, true]) test(`topic authorization is a chat/topic pair, callback=${callback}`, () => {
  const c = config();
  for (const id of [-1001, -1002]) {
    const message = { chat: { id, is_forum: true }, message_thread_id: 17 };
    const ctx = { from: { id: 7 }, ...(callback ? { callbackQuery: { message } } : { message }) };
    assert.equal(authorizeTelegramUpdate(ctx, c).ok, id === -1001);
    c.allowedChatIds.clear();
    assert.equal(authorizeTelegramUpdate(ctx, c).ok, id === -1001);
  }
});
test("ambiguous legacy topic config and malformed pair config fail closed", () => {
  const env = { TELEGRAM_BOT_TOKEN: "123:fixture", ALLOWED_USER_IDS: "7", ALLOWED_THREAD_IDS: "17" };
  for (const chats of ["", "-1001,-1002"]) assert.throws(() => readTelegramAccessConfig({ ...env, ALLOWED_CHAT_IDS: chats }), /exactly one/);
  for (const bindings of ['{}', '[["-1001",0]]', 'garbage']) assert.throws(() => readTelegramAccessConfig({ ...env, ALLOWED_THREAD_IDS: "", ALLOWED_TOPIC_BINDINGS: bindings }));
});
for (const change of ["user", "chat", "topic", "bot", "missing"]) test(`stored execution/delivery rejects ${change} without side effects`, async () => {
  const c = config(), p = record(); let sends = 0;
  const ctx = guardTelegramContext({ reply: async () => { sends++; }, telegram: { sendMessage: async () => { sends++; } } }, () => assertStoredRequest(p, c));
  await ctx.reply("before");
  if (change === "user") c.allowedUserIds.delete("7");
  if (change === "chat") c.allowedChatIds.delete("-1001");
  if (change === "topic") c.allowedTopicBindings = new Set([JSON.stringify(["-1002", "17"])]);
  if (change === "bot") p.botId = "999";
  if (change === "missing") delete p.requesterUserId;
  assert.throws(() => assertStoredRequest(p, c), { code: "quarantined_authorization" });
  await assert.rejects(ctx.reply("denied")); await assert.rejects(ctx.telegram.sendMessage(-1001, "denied"));
  assert.equal(sends, 1);
});
test("queue and recovery schema retain versioned provenance without inventing a requester", () => {
  const p = { ...record(), enqueuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 10000).toISOString() };
  const queue = normalizePendingTurn(serializePendingTurn(p), { chatKey: p.chatKey });
  const turn = createRecoveryTurn(recoveryCandidateFromSnapshot({ ...queue, threadId: "session-a" }));
  assert.deepEqual(provenanceFields(turn), provenanceFields(p));
  assert.deepEqual(provenanceFields(normalizeNotify(p)), provenanceFields(p));
  assertStoredRequest(turn, config());
  assert.throws(() => assertStoredRequest(createRecoveryTurn({ chatKey: "7", chatId: 7 }), config()));
});
test("session owner registry isolates bots/accounts/chats/topics and blocks both transports before resume", async (t) => {
  const c = { ...config(), botRecoveryDir: await temp(t) };
  registerSessionOwner(c, "-1001:topic:17", "default", "session-a");
  assert.equal(ownsSession(c, "-1001:topic:17", "default", "session-a"), true);
  for (const [key, account] of [["-1002:topic:17", "default"], ["-1001:topic:18", "default"], ["-1001:topic:17", "other"]]) {
    assert.throws(() => assertSessionOwner(c, key, account, "session-a"), /unavailable/);
    for (const transport of ["sdk", "app-server-direct"]) assert.throws(() => createCodexThread({ transport, threadId: "session-a", accountId: account, config: { ...c, sessionChatKey: key } }), /unavailable/);
  }
  assert.equal(ownsSession({ ...c, telegramBotToken: "999:fixture" }, "-1001:topic:17", "default", "session-a"), false);
  assert.throws(() => registerSessionOwner(c, "other", "default", "session-a"));
  assert.throws(() => assertSessionOwner(c, "-1001:topic:17", "default", "legacy"));
});

function upload(root, chunks, quotaBytes = 100) { return downloadAttachment({ uploadDir: root, quotaBytes, minFreeBytes: 0, maxBytes: 100, ext: ".png", formatBytes: String, getLink: async () => new URL("https://fixture.invalid"), fetchImpl: async () => ({ ok: true, headers: { get: () => "1" }, body: Readable.from(chunks.map((n) => Buffer.alloc(n))) }) }); }
test("aggregate quota serializes concurrent streams and counts existing/orphan files after restart", async (t) => {
  const root = await temp(t); await fs.writeFile(path.join(root, "existing.png"), Buffer.alloc(80));
  const results = await Promise.allSettled([upload(root, [15]), upload(root, [15])]);
  assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
  assert.match(results.find((x) => x.status === "rejected").reason.message, /quota exceeded/);
  await assert.rejects(upload(root, [3, 3]), /quota exceeded/);
  const sizes = await Promise.all((await fs.readdir(root, { recursive: true })).map(async (name) => { const stat = await fs.stat(path.join(root, name)); return stat.isFile() ? stat.size : 0; }));
  assert.equal(sizes.reduce((a, b) => a + b, 0), 95);
});
test("quota lock is shared by separate processes and released on process death; orphan bytes remain charged", async (t) => {
  const root = await temp(t);
  const moduleUrl = new URL("../src/telegram/upload_quota.js", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `import {acquireUploadQuota} from ${JSON.stringify(moduleUrl)};import fs from 'node:fs/promises';await acquireUploadQuota(${JSON.stringify(root)},{quotaBytes:100,minFreeBytes:0});await fs.writeFile(${JSON.stringify(path.join(root, "orphan.png"))},Buffer.alloc(90));process.stdout.write('ready');setInterval(()=>{},1000);`], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill("SIGKILL"));
  await once(child.stdout, "data");
  let acquired = false;
  const pending = acquireUploadQuota(root, { quotaBytes: 100, minFreeBytes: 0 }).then((q) => { acquired = true; return q; });
  await new Promise((resolve) => setTimeout(resolve, 80)); assert.equal(acquired, false);
  child.kill("SIGKILL"); await once(child, "exit");
  const q = await pending;
  try { await assert.rejects(q.grow(11), /quota exceeded/); await q.grow(10); } finally { await q.release(); }
});
test("artifact registration permits only current-turn host output and snapshots bytes", async (t) => {
  const c = { ...config(), botRecoveryDir: await temp(t) }, a = record(), b = { ...record(), id: "turn-b" };
  await prepareTurnArtifacts(a, c); await prepareTurnArtifacts(b, c);
  const aRoot = (await turnArtifactOptions(a, c)).allowedRoots[0], bRoot = (await turnArtifactOptions(b, c)).allowedRoots[0];
  const aFile = path.join(aRoot, "a.png"), bFile = path.join(bRoot, "b.png");
  a.accountId = "rotated";
  assert.equal((await turnArtifactOptions(a, c)).allowedRoots[0], aRoot);
  await fs.writeFile(aFile, "approved"); await fs.writeFile(bFile, "other turn");
  const answer = `[[telegram_photo:${aFile}]]\n[[telegram_photo:${bFile}]]`;
  const extracted = await extractTelegramPhotoArtifacts(answer, await turnArtifactOptions(a, c));
  assert.equal(extracted.photos.length, 1); assert.equal(extracted.rejected.length, 1);
  await fs.writeFile(aFile, "replaced"); assert.equal(validatedPhotoContents(extracted.photos[0]).toString(), "approved");
  assert.equal((await extractTelegramPhotoArtifacts(answer)).photos.length, 0);
  c.allowedUserIds.delete("7"); await assert.rejects(turnArtifactOptions(a, c));
});
test("dashboard stop checks requester and authoritative task owner before abort/cancel", async () => {
  let cancelled = 0, aborted = 0, stopped = 0;
  const a = { currentPreparedTurn: { requesterUserId: "7" }, abortController: { abort() { aborted++; } }, workerJobId: "a" };
  const b = { currentPreparedTurn: { requesterUserId: "8" }, abortController: { abort() { assert.fail("other owner aborted"); } }, workerJobId: "b" };
  const legacy = { abortController: { abort() { assert.fail("legacy aborted"); } } };
  const ctx = { from: { id: 7 }, chat: { id: -1001 }, message: { message_thread_id: 17 } };
  const controller = createDashboardController({ btn: () => ({}), dashboard: { activeFor: () => [["scheduled:a", a], ["scheduled:b", b], ["legacy", legacy]], describe: async () => "" }, execution: { cancel: async () => { cancelled++; } }, meta: () => ({ chatId: -1001, messageThreadId: 17 }), scheduler: { stopRun: async () => { stopped++; } }, state: { panelPreferences: {}, tasks: { a: { id: "a", owner: "-1001:17:7" }, b: { id: "b", owner: "-1001:17:8" } } }, t: String, ui: { show: async () => {} } });
  await controller.action(ctx, { type: "stop" }); await controller.action(ctx, { type: "stop" });
  assert.equal(cancelled, 1); assert.equal(aborted, 1); assert.equal(stopped, 1); assert.equal(b.stopRequested, undefined); assert.equal(legacy.stopRequested, undefined);
});
test("complete lock approval rejects same-version CLI bytes, bin and platform mutations", () => {
  const next = { packages: { "node_modules/@openai/codex-sdk": { version: "1.0.0", integrity: "sdk" }, "node_modules/@openai/codex": { version: "1.0.0", integrity: "cli", bin: { codex: "bin.js" } } } };
  const sdk = { version: "1.0.0", integrity: "sdk", lockSha256: dependencyGraphDigest(next) };
  validateDependencyLock(next, next, sdk, "1.0.0");
  for (const mutate of [(x) => { x.packages["node_modules/@openai/codex"].integrity = "evil"; }, (x) => { x.packages["node_modules/@openai/codex"].bin.node = "evil.js"; }, (x) => { x.packages["node_modules/@openai/codex-linux"] = { version: "1.0.0" }; }]) {
    const changed = globalThis.structuredClone(next); mutate(changed); assert.throws(() => validateDependencyLock(next, changed, sdk, "1.0.0"), /graph integrity/);
  }
});
test("publication requires independent exact file approval; self-consistent registry metadata is insufficient", () => {
  const data = { "package.json": "{}", "package-lock.json": "{}" };
  assert.throws(() => requirePackageApproval(data, {}), /Independent/);
  const hash = createHash("sha256").update("{}").digest("hex");
  requirePackageApproval(data, { packageSha256: hash, lockSha256: hash });
  assert.throws(() => requirePackageApproval({ ...data, "package-lock.json": "{} " }, { packageSha256: hash, lockSha256: hash }));
  const before = { dependencies: { "@openai/codex-sdk": "1.0.0" } }, after = { dependencies: { "@openai/codex-sdk": "1.0.1" } };
  for (const source of ["codex", "dependabot"]) assert.equal(manifestAllowed(before, after, source), false);
});
for (const conclusion of ["neutral", "skipped", "failure", "timed_out", null]) test(`audit ${conclusion} never authorizes merge`, () => {
  const checks = REQUIRED_CHECKS.map((name) => ({ name, head_sha: "a".repeat(40), app: { slug: "github-actions" }, status: "completed", conclusion: name === "Security audit" ? conclusion : "success" }));
  assert.equal(checksPassed(checks, [], "a".repeat(40)), false);
});
test("every external workflow action is immutable and credentialed reviewer has no executable credential path", async () => {
  for (const name of await fs.readdir(new URL("../.github/workflows/", import.meta.url))) {
    const source = await fs.readFile(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8");
    for (const match of source.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)) assert.match(match[1], /^[\w./-]+@[a-f0-9]{40}$/);
  }
  const reviewer = await fs.readFile(new URL("../.github/workflows/codex-pr-review.yml", import.meta.url), "utf8");
  assert.doesNotMatch(reviewer, /secrets\.|codex login|npm install|pull-requests: write/);
  assert.match(reviewer, /review-disabled:/);
  assert.equal(actionRefsOnly("uses: actions/checkout@" + "a".repeat(40), "uses: actions/checkout@v7"), false);
});

test("Codex lock-only integrity, platform and bin changes cannot auto-merge", () => {
  const before = { packages: { "": {}, "node_modules/@openai/codex": { version: "1.0.0", integrity: "approved", bin: { codex: "cli.js" } } } };
  assert.equal(lockfileAllowed(before, before, {}), true);
  for (const change of ["integrity", "bin", "platform"]) {
    const after = globalThis.structuredClone(before);
    if (change === "integrity") after.packages["node_modules/@openai/codex"].integrity = "changed";
    if (change === "bin") after.packages["node_modules/@openai/codex"].bin.node = "payload.js";
    if (change === "platform") after.packages["node_modules/@openai/codex-linux-arm64"] = { version: "1.0.0" };
    assert.equal(lockfileAllowed(before, after, {}), false);
  }
});
