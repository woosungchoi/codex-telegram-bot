import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { buildCodexChildEnv } from "../src/codex/child_env.js";
import { buildCodexClientOptions } from "../src/codex/thread_factory.js";
import { fullBackupAuthorized, requireFullBackup, verifyBackupDestination } from "../src/maintenance/backup_authorization.js";
import { anchoredCreate, anchoredMove, anchoredUnlink, fileIdentity } from "../src/fs/anchored.js";
import { listUploadFiles, deleteUploadCandidates } from "../src/uploads.js";
import { approvedArtifact, extractApprovedBinary } from "../src/maintenance/update_artifact.js";
import { stageCodexRelease } from "../src/maintenance/update_install.js";
import { validatePackageUpdate, readCandidate } from "../scripts/publish_package_update.mjs";
import { tarFixture } from "./helpers/tar_fixture.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "security-seven-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
const admin = { from: { id: 7 }, chat: { id: 7, type: "private" } };
const config = { allowedUserIds: new Set(["7", "8"]), backupAdminUserIds: new Set(["7", "9"]) };

for (const managed of [false, true]) test(`child environment is a positive allowlist (managed=${managed})`, () => {
  const base = { PATH: "/bin", HOME: "/home/test", CODEX_API_KEY: "codex-auth", TELEGRAM_BOT_TOKEN: "sentinel", FUTURE_SECRET: "sentinel", GH_TOKEN: "sentinel", NODE_OPTIONS: "--import evil", LD_PRELOAD: "evil" };
  const env = buildCodexChildEnv({ UNKNOWN_SECRET: "sentinel", TELEGRAM_BOT_TOKEN: "override", LANG: "en_US.UTF-8" }, { base, managed, home: "/account" });
  assert.equal(env.PATH, "/bin"); assert.equal(env.CODEX_HOME, "/account");
  assert.equal(env.LANG, "en_US.UTF-8");
  assert.equal(env.CODEX_API_KEY, managed ? undefined : "codex-auth");
  for (const key of ["TELEGRAM_BOT_TOKEN", "FUTURE_SECRET", "GH_TOKEN", "NODE_OPTIONS", "LD_PRELOAD", "UNKNOWN_SECRET"]) assert.equal(env[key], undefined);
});
test("SDK receives explicit filtered environment even when overrides are absent", () => {
  const old = process.env.FUTURE_SECRET;
  process.env.FUTURE_SECRET = "sentinel";
  try { const opts = buildCodexClientOptions({ codexHome: "/account" }); assert.equal(opts.env.FUTURE_SECRET, undefined); assert.equal(opts.env.CODEX_HOME, "/account"); }
  finally { if (old === undefined) delete process.env.FUTURE_SECRET; else process.env.FUTURE_SECRET = old; }
});
for (const ctx of [{}, { from: { id: 8 }, chat: { id: 8, type: "private" } }, { from: { id: 7 }, chat: { id: -100, type: "supergroup" } }, { from: { id: 9 }, chat: { id: 9, type: "private" } }, { from: { id: 7 }, chat: { id: 8, type: "private" } }]) {
  test(`full backup refuses unauthorized context ${JSON.stringify(ctx)}`, () => {
    assert.equal(fullBackupAuthorized(ctx, config), false);
    assert.throws(() => requireFullBackup(ctx, config));
  });
}
test("full backup rechecks authorization and destination immediately before delivery", () => {
  const snapshot = requireFullBackup(admin, config);
  verifyBackupDestination(admin, config, snapshot);
  assert.throws(() => verifyBackupDestination({ ...admin, chat: { id: 8, type: "private" } }, config, snapshot));
  assert.throws(() => verifyBackupDestination(admin, { ...config, backupAdminUserIds: new Set() }, snapshot));
});

test("uploads dry-run preserves candidates and real cleanup removes matching files", async (t) => {
  const root = await fixture(t), file = path.join(root, "upload"); await fs.writeFile(file, "data");
  const candidates = await listUploadFiles(root);
  assert.equal((await deleteUploadCandidates(candidates, { rootDir: root })).deleted, 0);
  assert.equal(await fs.readFile(file, "utf8"), "data");
  assert.equal((await deleteUploadCandidates(candidates, { rootDir: root, dryRun: false })).deleted, 1);
});
test("cleanup refuses replaced inode and old plans without identity", async (t) => {
  const root = await fixture(t), file = path.join(root, "file"); await fs.writeFile(file, "old");
  const identity = fileIdentity(await fs.lstat(file));
  await fs.rename(file, `${file}.old`); await fs.writeFile(file, "new");
  await assert.rejects(anchoredUnlink(root, file, identity), /identity changed/);
  await assert.rejects(anchoredUnlink(root, file), /identity changed/);
  assert.equal(await fs.readFile(file, "utf8"), "new");
});
for (const position of ["parent", "file"]) test(`cleanup rejects a ${position} symlink`, async (t) => {
  const root = await fixture(t), outside = await fixture(t);
  const victim = path.join(outside, "victim"); await fs.writeFile(victim, "keep");
  const link = path.join(root, "link"); await fs.symlink(position === "parent" ? outside : victim, link);
  await assert.rejects(anchoredUnlink(root, position === "parent" ? path.join(link, "victim") : link, fileIdentity(await fs.lstat(victim))));
  assert.equal(await fs.readFile(victim, "utf8"), "keep");
});
test("unlink pins parent across a deterministic directory-swap race", async (t) => {
  const root = await fixture(t), outside = await fixture(t), parent = path.join(root, "parent");
  await fs.mkdir(parent); const file = path.join(parent, "victim"); await fs.writeFile(file, "old"); await fs.writeFile(path.join(outside, "victim"), "keep");
  const identity = fileIdentity(await fs.lstat(file)), unlink = fs.unlink;
  fs.unlink = async (target) => { await fs.rename(parent, `${parent}.old`); await fs.symlink(outside, parent); return unlink(target); };
  try { await anchoredUnlink(root, file, identity); } finally { fs.unlink = unlink; }
  assert.equal(await fs.readFile(path.join(outside, "victim"), "utf8"), "keep");
  await assert.rejects(fs.access(path.join(`${parent}.old`, "victim")));
});
test("quarantine pins destination across directory-swap race and preserves outside victim", async (t) => {
  const root = await fixture(t), outside = await fixture(t), src = path.join(root, "source"), dst = path.join(root, "quarantine");
  await fs.writeFile(src, "move"); await fs.mkdir(dst); await fs.writeFile(path.join(outside, "target"), "keep");
  const link = fs.link;
  fs.link = async (from, to) => { await fs.rename(dst, `${dst}.old`); await fs.symlink(outside, dst); return link(from, to); };
  try { await anchoredMove(root, src, fileIdentity(await fs.lstat(src)), dst, path.join(dst, "target"), "{}"); } finally { fs.link = link; }
  assert.equal(await fs.readFile(path.join(outside, "target"), "utf8"), "keep");
  assert.equal(await fs.readFile(path.join(`${dst}.old`, "target"), "utf8"), "move");
});
test("quarantine refuses destination symlinks and hardlinked source", async (t) => {
  const root = await fixture(t), outside = await fixture(t), src = path.join(root, "source"), dst = path.join(root, "link");
  await fs.writeFile(src, "keep"); await fs.symlink(outside, dst);
  await assert.rejects(anchoredMove(root, src, fileIdentity(await fs.lstat(src)), dst, path.join(dst, "target")));
  await fs.link(src, path.join(outside, "hardlink"));
  await assert.rejects(anchoredMove(root, src, fileIdentity(await fs.lstat(src)), root, path.join(root, "target")), /Hardlinked/);
  assert.deepEqual(await fs.readdir(outside), ["hardlink"]);
});
for (const position of ["root", "ancestor", "file"]) test(`handoff refuses ${position} symlinks and never truncates targets`, async (t) => {
  const root = await fixture(t), outside = await fixture(t), victim = path.join(outside, "victim"); await fs.writeFile(victim, "keep");
  let dir = path.join(root, "handoffs");
  if (position === "file") { await fs.mkdir(dir); await fs.symlink(victim, path.join(dir, "note.md")); }
  else { await fs.symlink(outside, dir); if (position === "ancestor") dir = path.join(dir, "nested"); }
  await assert.rejects(anchoredCreate(dir, "note.md", "overwrite"));
  assert.equal(await fs.readFile(victim, "utf8"), "keep");
});
test("private handoff uses 0700/0600 under umask022 and refuses filename reuse", async (t) => {
  const root = await fixture(t), dir = path.join(root, "private", "handoffs"), mask = process.umask(0o022);
  try { await anchoredCreate(dir, "note.md", "secret"); } finally { process.umask(mask); }
  assert.equal((await fs.stat(dir)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(dir, "note.md"))).mode & 0o777, 0o600);
  await assert.rejects(anchoredCreate(dir, "note.md", "changed"), { code: "EEXIST" });
  assert.equal(await fs.readFile(path.join(dir, "note.md"), "utf8"), "secret");
});

test("updater with no trust fails before any download or executable starts", async () => {
  let ran = false;
  await assert.rejects(stageCodexRelease({}, { target: "0.160.0" }, async () => { ran = true; }), /independently/);
  assert.equal(ran, false);
});
test("trust manifest binds exact version and platform and refuses permissive or linked files", async (t) => {
  const root = await fixture(t), file = path.join(root, "trust.json"), { entry } = tarFixture();
  await fs.writeFile(file, JSON.stringify({ artifacts: [entry] }), { mode: 0o600 });
  const cfg = { codexUpdateTrustFile: file };
  assert.deepEqual(await approvedArtifact(cfg, entry.version), entry);
  await assert.rejects(approvedArtifact(cfg, "99.0.0"));
  await fs.writeFile(file, JSON.stringify({ artifacts: [{ ...entry, arch: "wrong" }] }));
  await assert.rejects(approvedArtifact(cfg, entry.version));
  await fs.chmod(file, 0o666); await assert.rejects(approvedArtifact(cfg, entry.version), /Unsafe/);
  await fs.symlink(file, `${file}.link`); await assert.rejects(approvedArtifact({ codexUpdateTrustFile: `${file}.link` }, entry.version));
});
test("artifact hash is checked before archive parsing", () => {
  const { archive, entry } = tarFixture();
  assert.equal(extractApprovedBinary(archive, entry).toString(), "verified executable");
  assert.throws(() => extractApprovedBinary(Buffer.from("malicious not gzip"), entry), /digest mismatch/);
});
for (const changes of [{ name: "../codex-test" }, { name: "/codex-test" }, { type: "2" }, { type: "1" }, { type: "x" }, { name: "another-binary" }]) test(`approved archive still rejects unsafe entry ${JSON.stringify(changes)}`, () => {
  const { archive, entry } = tarFixture(changes); assert.throws(() => extractApprovedBinary(archive, entry));
});

test("package publisher accepts only bounded version-only JSON and registry lock entries", async () => {
  const base = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8"));
  const lock = JSON.parse(await fs.readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
  validatePackageUpdate(base, base, lock);
  const evil = globalThis.structuredClone(base); evil.scripts.postinstall = "steal token";
  assert.throws(() => validatePackageUpdate(base, evil, lock), /Only Codex/);
  const badLock = globalThis.structuredClone(lock); badLock.packages["node_modules/payload"] = { version: "1.0.0", resolved: "https://evil.invalid/payload", integrity: "sha512-AAAA" };
  assert.throws(() => validatePackageUpdate(base, base, badLock), /Unsafe lock/);
  evil.scripts = base.scripts; evil.dependencies["@openai/codex-sdk"] = "file:./payload";
  assert.throws(() => validatePackageUpdate(base, evil, lock), /Stable pinned/);
});
test("publisher rejects extra executable artifacts and symbolic package files", async (t) => {
  const root = await fixture(t);
  for (const name of ["package.json", "package-lock.json"]) await fs.writeFile(path.join(root, name), "{}");
  assert.equal(Object.keys(await readCandidate(root)).length, 2);
  await fs.writeFile(path.join(root, "run.sh"), "evil"); await assert.rejects(readCandidate(root), /only two/);
  await fs.unlink(path.join(root, "run.sh")); await fs.unlink(path.join(root, "package.json"));
  await fs.symlink("package-lock.json", path.join(root, "package.json")); await assert.rejects(readCandidate(root));
});
test("credential-bearing workflow jobs never run PR helpers or new dependency code", async () => {
  const read = async (name) => fs.readFile(new URL(`../.github/workflows/${name}.yml`, import.meta.url), "utf8");
  const review = await read("codex-pr-review"), update = await read("codex-sdk-update");
  const [reviewJob, reviewPublish] = review.split("  publish:");
  assert.match(reviewJob, /head.repo.full_name == github.repository/);
  assert.match(reviewJob, /ref: \$\{\{ github.event.pull_request.base.sha \}\}/);
  assert.doesNotMatch(reviewJob, /pull-requests: write|GITHUB_TOKEN:|run: node scripts\/github_comment/);
  assert.doesNotMatch(reviewPublish, /CODEX_ACCESS_TOKEN|npm (ci|install)|codex exec/);
  assert.match(reviewPublish, /EXPECTED_HEAD:/);
  const [installJob, publishJob] = update.split("  publish:");
  assert.doesNotMatch(installJob, /contents: write|pull-requests: write|secrets\.|GH_TOKEN:|GITHUB_TOKEN:/);
  assert.match(installJob, /persist-credentials: false/);
  assert.doesNotMatch(publishJob, /npm (ci|install|test)|npm run|codex --version/);
  assert.match(publishJob, /ref: \$\{\{ github.sha \}\}/);
  assert.match(publishJob, /publish_package_update.mjs/);
  for (const workflow of [review, update]) for (const match of workflow.matchAll(/uses: ([^\n]+)/g)) assert.match(match[1], /@[a-f0-9]{40}( |$)/);
});

test("digest mismatch never launches even the downloaded binary's version probe", async (t) => {
  const root = await fixture(t), { entry } = tarFixture(), calls = [], trust = path.join(root, "trust.json");
  await fs.writeFile(trust, JSON.stringify({ artifacts: [entry] }), { mode: 0o600 });
  await assert.rejects(stageCodexRelease({ codexUpdateDir: path.join(root, "updates"), codexUpdateTrustFile: trust }, { target: entry.version }, async (cmd, args) => {
    calls.push(cmd); await fs.writeFile(args.at(-1), "untrusted payload"); return { stdout: "" };
  }), /digest mismatch/);
  assert.deepEqual(calls, ["curl"]);
  assert.deepEqual(await fs.readdir(path.join(root, "updates")), []);
});

test("quarantine rejects a source parent replaced with an external symlink after preview", async (t) => {
  const root = await fixture(t), outside = await fixture(t), sourceDir = path.join(root, "source"), dest = path.join(root, "quarantine");
  await fs.mkdir(sourceDir); const source = path.join(sourceDir, "file"); await fs.writeFile(source, "old");
  const identity = fileIdentity(await fs.lstat(source));
  await fs.writeFile(path.join(outside, "file"), "outside keep");
  await fs.rename(sourceDir, `${sourceDir}.old`); await fs.symlink(outside, sourceDir);
  await assert.rejects(anchoredMove(root, source, identity, dest, path.join(dest, "file")));
  assert.equal(await fs.readFile(path.join(outside, "file"), "utf8"), "outside keep");
  await assert.rejects(fs.access(dest));
});
