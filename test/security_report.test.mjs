import { getCodexClient } from "../src/codex/thread_factory.js";
import { createAppServerThread } from "../src/codex/app_server.js";
import { nativeSessionConfig, nativeTurnSandbox } from "../src/codex/session_settings.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { createFrameReader } from "../src/worker/protocol.js";
import { authorizeWorkerRequest, questionCapability, assertWorkerExecutionBoundary } from "../src/worker/auth.js";
import { downloadAttachment } from "../src/telegram/download.js";
import { resolvePhotoArtifactCandidates } from "../src/telegram/attachments.js";
import { replyTelegramPhotos } from "../src/telegram/photo.js";
import { upsertActiveTurnSnapshot, replaceActiveTurnSnapshot, removeActiveTurnSnapshot, readActiveTurnSnapshots } from "../src/recovery/state.js";

async function temp(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bot-security-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test("concurrent recovery mutations retain other chats and completed turns stay removed", async (t) => {
  const root = await temp(t);
  await Promise.all(Array.from({ length: 40 }, (_, i) => upsertActiveTurnSnapshot(root, `chat-${i}`, { inputPreview: `${i}` })));
  assert.equal(Object.keys((await readActiveTurnSnapshots(root)).turns).length, 40);
  await Promise.all([removeActiveTurnSnapshot(root, "chat-0"), upsertActiveTurnSnapshot(root, "chat-1", { threadId: "one" }), upsertActiveTurnSnapshot(root, "chat-0", { threadId: "stale" })]);
  assert.equal((await readActiveTurnSnapshots(root)).turns["chat-0"], undefined);
  await replaceActiveTurnSnapshot(root, "chat-0", { threadId: "new" });
  assert.equal((await readActiveTurnSnapshots(root)).turns["chat-0"].threadId, "new");
});

test("IPC byte limit precedes parsing and unfinished frames expire", async () => {
  for (const input of ["x".repeat(33), '"' + "한".repeat(11)]) {
    const stream = new PassThrough(), errors = [];
    createFrameReader(stream, () => assert.fail("oversized frame dispatched"), { maxBytes: 32, onError: (e) => errors.push(e) });
    stream.write(input);
    assert.equal(stream.destroyed, true);
    assert.equal(errors.length, 1);
    assert.equal(stream.listenerCount("data"), 0);
  }
  const stream = new PassThrough(), errors = [];
  createFrameReader(stream, () => assert.fail(), { frameTimeoutMs: 10, onError: (e) => errors.push(e) });
  stream.write("{");
  await delay(30);
  assert.equal(stream.destroyed, true);
  assert.equal(errors.length, 1);
  const boundary = new PassThrough(), frames = [];
  createFrameReader(boundary, (v) => frames.push(v), { maxBytes: 2 });
  boundary.write("{}\n{}\n\n"); boundary.end();
  assert.deepEqual(frames, [{}, {}]);
});

test("worker credentials cannot be replaced with unscoped or expired question capabilities", () => {
  const secret = "a".repeat(64);
  for (const method of ["job/start", "job/events", "question/answer", "worker/status"]) {
    assert.throws(() => authorizeWorkerRequest(secret, { method }), /authorized/);
  }
  const auth = questionCapability(secret, "job-a", 100);
  authorizeWorkerRequest(secret, { auth, method: "question/ask", params: { jobId: "job-a" } }, 99);
  for (const request of [
    { auth, method: "job/start", params: { jobId: "job-a" } },
    { auth, method: "question/ask", params: { jobId: "job-b" } },
    { auth: `${auth}x`, method: "question/ask", params: { jobId: "job-a" } }
  ]) assert.throws(() => authorizeWorkerRequest(secret, request, 99), /authorized/);
  assert.throws(() => authorizeWorkerRequest(secret, { auth, method: "question/ask", params: { jobId: "job-a" } }, 100), /authorized/);
  assert.throws(() => assertWorkerExecutionBoundary({}, {}), /OS-isolated/);
  assert.throws(() => assertWorkerExecutionBoundary({ codexSandboxMode: "danger-full-access" }, { sandboxMode: "read-only" }), /OS-isolated/);
  assert.throws(() => assertWorkerExecutionBoundary({ codexSandboxMode: "danger-full-access" }, {}), /OS-isolated/);
  assertWorkerExecutionBoundary({ codexSandboxMode: "danger-full-access" }, { sandboxMode: "danger-full-access" });
});

test("attachment limits count actual streamed bytes, abort, and remove partial files", async (t) => {
  const uploadDir = await temp(t);
  let aborted = false;
  const body = Readable.from([Buffer.from("1234"), Buffer.from("5678"), Buffer.from("9")], { highWaterMark: 1 });
  await assert.rejects(downloadAttachment({
    uploadDir, ext: ".png", maxBytes: 5, formatBytes: String,
    getLink: async () => new URL("https://example.invalid/file"),
    fetchImpl: async (_, { signal }) => {
      signal.addEventListener("abort", () => { aborted = true; });
      return { ok: true, headers: { get: () => "1" }, body };
    }
  }));
  assert.equal(aborted, true);
  assert.equal(body.destroyed, true);
  assert.deepEqual(await fs.readdir(uploadDir), []);
});

test("attachment parent symlinks are rejected and random exclusive uploads stay separate", async (t) => {
  const root = await temp(t), target = path.join(root, "target"), link = path.join(root, "link");
  await fs.mkdir(target); await fs.symlink(target, link);
  const options = { uploadDir: link, ext: ".png", maxBytes: 20, formatBytes: String, getLink: async () => new URL("https://example.invalid/file"), fetchImpl: async () => ({ ok: true, body: Readable.from([Buffer.from("fixture")]) }) };
  await assert.rejects(downloadAttachment(options), /symlinks/);
  assert.deepEqual(await fs.readdir(target), []);
  const files = await Promise.all([downloadAttachment({ ...options, uploadDir: target }), downloadAttachment({ ...options, uploadDir: target })]);
  assert.notEqual(files[0].path, files[1].path);
  assert.equal((await fs.stat(files[0].path)).mode & 0o777, 0o600);
});

test("photo symlink escape fails and post-validation replacement cannot change sent bytes", async (t) => {
  const root = await temp(t), allowed = path.join(root, "allowed"), outside = path.join(root, "outside.png");
  await fs.mkdir(allowed); await fs.writeFile(outside, "outside sentinel");
  const candidate = path.join(allowed, "image.png");
  await fs.symlink(outside, candidate);
  const rejected = await resolvePhotoArtifactCandidates([{ path: candidate }], { allowedRoots: [allowed] });
  assert.equal(rejected.photos.length, 0);
  assert.equal(rejected.rejected[0].reason, "outside_allowed_roots");
  await fs.unlink(candidate); await fs.writeFile(candidate, "inside fixture");
  const { photos } = await resolvePhotoArtifactCandidates([{ path: candidate }], { allowedRoots: [allowed] });
  await fs.unlink(candidate); await fs.symlink(outside, candidate);
  await replyTelegramPhotos({ replyWithPhoto: async ({ source }) => { assert.equal(source.toString(), "inside fixture"); return {}; } }, photos);
  await assert.rejects(replyTelegramPhotos({ replyWithPhoto: async () => assert.fail() }, [{ path: outside }]), /not validated/);
});

test("direct transport rejects non-Git workspaces before spawning and does not retain old write roots", async (t) => {
  const root = await temp(t);
  const thread = createAppServerThread({ codexPath: "/must-not-be-spawned", threadOptions: { workingDirectory: root, skipGitRepoCheck: false } });
  await assert.rejects(thread.runStreamed("fixture"), /trusted Git/);
  assert.equal(nativeSessionConfig({ webSearchEnabled: false, webSearchMode: "live" }).web_search, "disabled");
  const policy = nativeTurnSandbox({ workingDirectory: "/repo", additionalDirectories: ["/new"], networkAccessEnabled: false }, { type: "workspaceWrite", writableRoots: ["/stale", "/"], networkAccess: true });
  assert.deepEqual(policy.writableRoots, ["/repo", "/new"]);
  assert.equal(policy.networkAccess, false);
});

test("SDK job question credentials are never cached across jobs", () => {
  const clients = new Map();
  const config = { codexPath: "/unused", codexWorkerQuestionCapability: "job-a" };
  const first = getCodexClient(clients, config);
  const second = getCodexClient(clients, { ...config, codexWorkerQuestionCapability: "job-b" });
  assert.notEqual(first, second);
  assert.equal(clients.size, 0);
});

test("network denial fails closed for unknown/full-access native policies", () => {
  for (const policy of [undefined, { type: "dangerFullAccess" }, { type: "externalSandbox" }]) {
    assert.throws(() => nativeTurnSandbox({ networkAccessEnabled: false }, policy), /cannot enforce/);
  }
  assert.deepEqual(nativeTurnSandbox({ networkAccessEnabled: false }, { type: "readOnly", networkAccess: true }), { type: "readOnly", networkAccess: false });
  assert.throws(() => assertWorkerExecutionBoundary({ codexSandboxMode: "danger-full-access" }, { sandboxMode: "danger-full-access", explicitOptions: [] }), /OS-isolated/);
});

test("untrusted CI logs are never sent to credentialed model diagnosis", async () => {
  const workflow = await fs.readFile(new URL("../.github/workflows/codex-ci-diagnosis.yml", import.meta.url), "utf8");
  assert.doesNotMatch(workflow, /CODEX_ACCESS_TOKEN|codex exec|codex login/);
  assert.match(workflow, /scripts\/ci_diagnosis\.mjs/);
  assert.match(workflow, /failed-tail\.redacted\.log/);
});
