import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readBoundedFile, probeDirectory } from "../src/fs/bounded.js";
import { anchoredCreate, fileIdentity } from "../src/fs/anchored.js";
import { createCleanupArtifact, finalizeCleanupArtifact } from "../src/maintenance/cleanup.js";
import { readControlRecord } from "../src/maintenance/control_receipt.js";
import { operatorAuthorized, requireOperator, verifyOperator, requireQueueOwner, rememberControlConfirmation, consumeControlConfirmation } from "../src/operator_authorization.js";
import { createWorkerRecoveryTurn } from "../src/recovery/worker_runtime_controller.js";
import { authorizeStoredRequest } from "../src/authorization.js";
import { dependencyTreeDigest } from "../src/maintenance/tree_integrity.js";
import { metadataText, generateDiagnosis } from "../scripts/ci_diagnosis.mjs";
import { notificationTarget, sendBackgroundNotification } from "../src/telegram/background_notification.js";
import { operatorCtx, operatorConfig } from "./helpers/security17.mjs";
const run = promisify(execFile);
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "security17-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function restoreFixture(t) {
  const root = await fixture(t), sessions = path.join(root, "sessions"), quarantine = path.join(root, "quarantine"), control = path.join(root, "control");
  await fs.mkdir(sessions); await fs.mkdir(quarantine);
  const source = path.join(quarantine, "session.jsonl"), target = path.join(sessions, "session.jsonl");
  await fs.writeFile(source, "retained session\n");
  const artifact = await createCleanupArtifact({ plan: { id: "fixture", operator: requireOperator(operatorCtx, operatorConfig) }, action: "both", cleanupArtifactDir: path.join(root, "artifacts"), controlDirectory: control, dateKey: "20261023" });
  await finalizeCleanupArtifact(artifact, [{ type: "quarantine", from: target, to: source, identity: fileIdentity(await fs.lstat(source)), sessionsRoot: sessions, quarantineRoot: quarantine }, { type: "delete", from: path.join(quarantine, "gone"), irreversible: true }], { quarantined: 1, deleted: 1 });
  const restore = () => run("python3", [path.resolve("scripts/restore-cleanup.py"), "--control-dir", control, "--id", artifact.id]);
  return { root, source, target, sessions, control, artifact, restore };
}
test("17/1 authenticated restore restores quarantine once and never recreates permanent deletions", async (t) => {
  const f = await restoreFixture(t);
  await f.restore();
  assert.equal(await fs.readFile(f.target, "utf8"), "retained session\n");
  await assert.rejects(fs.access(f.source));
  await assert.rejects(f.restore());
  assert.equal(await fs.readFile(f.target, "utf8"), "retained session\n");
});
for (const attack of ["manifest", "approval", "parent", "identity"]) {
  test(`17/1 restore refuses ${attack} substitution before moving payloads`, async (t) => {
    const f = await restoreFixture(t);
    if (attack === "manifest") await fs.appendFile(f.artifact.manifest, " ");
    if (attack === "approval") {
      const name = path.join(f.control, `${f.artifact.id}.json`), rec = JSON.parse(await fs.readFile(name));
      rec.body = rec.body.replace("session.jsonl", "outside.jsonl"); await fs.writeFile(name, JSON.stringify(rec));
      await assert.rejects(readControlRecord(f.control, f.artifact.id), /authentication/);
    }
    if (attack === "parent") { await fs.rename(f.sessions, `${f.sessions}-old`); await fs.symlink(`${f.sessions}-old`, f.sessions); }
    if (attack === "identity") { await fs.rename(f.source, `${f.source}-old`); await fs.writeFile(f.source, "replacement"); }
    await assert.rejects(f.restore());
    await assert.rejects(fs.access(f.target));
    await fs.access(f.source);
  });
}
test("17/2,4,9,13 operator authorization is private, explicit, origin-bound and revocable", () => {
  const config = { ...operatorConfig, operatorUserIds: new Set(["7", "8"]) };
  const record = requireOperator(operatorCtx, config);
  verifyOperator(operatorCtx, config, record);
  for (const ctx of [{ ...operatorCtx, from: { id: 9 } }, { ...operatorCtx, chat: { id: -100, type: "supergroup" } }]) assert.equal(operatorAuthorized(ctx, config), false);
  for (const patch of [{ botInfo: { id: 999 } }, { from: { id: 8 }, chat: { id: 8, type: "private" } }, { message: { message_thread_id: 99 } }]) assert.throws(() => verifyOperator({ ...operatorCtx, ...patch }, config, record));
  config.operatorUserIds.delete("7");
  assert.throws(() => verifyOperator(operatorCtx, config, record));
});
test("17/3,8 exclusive writes and probes reject final and parent symlinks without overwriting a sentinel", async (t) => {
  const root = await fixture(t), outside = path.join(root, "outside"), safe = path.join(root, "safe");
  await fs.mkdir(safe); await fs.writeFile(outside, "sentinel");
  await fs.symlink(outside, path.join(safe, "snapshot.json"));
  await assert.rejects(anchoredCreate(safe, "snapshot.json", "bad"));
  await fs.symlink(safe, path.join(root, "alias"));
  await assert.rejects(anchoredCreate(path.join(root, "alias"), "new.json", "bad"));
  await assert.rejects(probeDirectory(path.join(root, "alias")));
  await probeDirectory(safe);
  assert.equal(await fs.readFile(outside, "utf8"), "sentinel");
  assert.deepEqual(await fs.readdir(safe), ["snapshot.json"]);
});
test("17/11 bounded health reads refuse symlink, oversized files and FIFO without blocking", async (t) => {
  const root = await fixture(t), file = path.join(root, "state");
  await fs.writeFile(file, "{}"); assert.equal((await readBoundedFile(file, 4)).toString(), "{}");
  await fs.symlink(file, `${file}-link`); await assert.rejects(readBoundedFile(`${file}-link`));
  await fs.writeFile(file, "12345"); await assert.rejects(readBoundedFile(file, 4));
  await run("mkfifo", [`${file}-fifo`]); await assert.rejects(readBoundedFile(`${file}-fifo`));
});
test("17/12 dependency attestation detects byte changes, additions, deletions and escaping links", async (t) => {
  const root = await fixture(t), file = path.join(root, "module.js"); await fs.writeFile(file, "original");
  const original = await dependencyTreeDigest(root);
  await fs.writeFile(file, "changed!"); assert.notEqual(await dependencyTreeDigest(root), original);
  await fs.writeFile(file, "original"); assert.equal(await dependencyTreeDigest(root), original);
  await fs.writeFile(path.join(root, "extra.js"), "extra"); assert.notEqual(await dependencyTreeDigest(root), original);
  await fs.unlink(file); assert.notEqual(await dependencyTreeDigest(root), original);
  await fs.symlink("/etc/passwd", file); await assert.rejects(dependencyTreeDigest(root), /escapes/);
});
test("17/14 one group participant cannot mutate another request or shared queue policy", () => {
  const config = { ...operatorConfig, operatorUserIds: new Set(), queueAdminUserIds: new Set() };
  const ctx = { ...operatorCtx, chat: { id: -100, type: "supergroup", is_forum: true }, message: { message_thread_id: 2 } };
  const owned = { authorizationVersion: 1, botId: "12345", requesterUserId: "7", chatId: "-100", chatType: "supergroup", isForum: true, messageThreadId: 2, accountId: "default" };
  requireQueueOwner(ctx, config, [owned]);
  assert.throws(() => requireQueueOwner(ctx, config, [{ ...owned, requesterUserId: "8" }]));
  assert.throws(() => requireQueueOwner(ctx, config, [owned], { sharedPolicy: true }));
  config.queueAdminUserIds.add("7"); requireQueueOwner(ctx, config, [owned], { sharedPolicy: true });
});
test("17/16 CI metadata cannot add Markdown headings, links, code fences or mentions", () => {
  const hostile = "name\n## forged\n``` @everyone [click](https://evil.invalid)";
  const escaped = metadataText(hostile);
  assert.equal(escaped.includes("\n"), false); assert.equal(escaped.includes("@everyone"), false);
  assert.equal(escaped.includes("[click]("), false); assert.ok(escaped.includes("\\#\\#"));
  const report = generateDiagnosis({ run: { name: hostile, display_title: hostile, html_url: "https://evil.invalid", id: "1; bad" } });
  assert.equal(report.markdown.includes("https://evil.invalid\n"), false);
  assert.equal(report.markdown.includes("gh run rerun --failed 1;"), false);
});
test("17/17 notification requires requester provenance and checks revoked policy before sending", async (t) => {
  const root = await fixture(t);
  const target = { ...requireOperator(operatorCtx, operatorConfig), threadId: "", chatId: "7" };
  assert.throws(() => notificationTarget({ botId: "12345", chatId: "7" }, operatorConfig));
  const verified = notificationTarget(target, operatorConfig);
  let sent = 0;
  const result = await sendBackgroundNotification({ target: verified, text: "done", receiptPath: path.join(root, "receipt"),
    authorize: async () => { throw new Error("revoked"); },
    telegram: { getMe: async () => ({ id: 12345, is_bot: true }), sendMessage: async () => { sent++; } } });
  assert.equal(result.ok, false); assert.equal(sent, 0);
});
test("recovery regression retains complete verified provenance and rejects revoked or legacy records", () => {
  const original = { ...requireOperator(operatorCtx, operatorConfig), workerJobId: "job", inputPreview: "recover" };
  const recovered = createWorkerRecoveryTurn("7", original);
  assert.equal(authorizeStoredRequest(recovered, operatorConfig), true);
  assert.equal(recovered.accountId, "default");
  assert.equal(recovered.requesterUserId, "7");
  assert.equal(authorizeStoredRequest(recovered, { ...operatorConfig, allowedUserIds: new Set() }), false);
  for (const missing of ["authorizationVersion", "botId", "requesterUserId", "accountId"]) {
    const copy = { ...original }; delete copy[missing];
    assert.equal(authorizeStoredRequest(createWorkerRecoveryTurn("7", copy), operatorConfig), false);
  }
});

test("control confirmations bind requester and exact targets and are single use", () => {
  const state = {}, records = [{ id: "job1", requesterUserId: "7", botId: "12345", accountId: "default" }];
  rememberControlConfirmation(state, operatorCtx, "clear", records);
  assert.throws(() => consumeControlConfirmation(state, { ...operatorCtx, from: { id: 8 } }, "clear", records));
  assert.throws(() => consumeControlConfirmation(state, operatorCtx, "clear", [...records, { ...records[0], id: "job2" }]));
  rememberControlConfirmation(state, operatorCtx, "clear", records);
  consumeControlConfirmation(state, operatorCtx, "clear", records);
  assert.throws(() => consumeControlConfirmation(state, operatorCtx, "clear", records));
});
