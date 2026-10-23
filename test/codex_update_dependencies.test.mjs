import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { stageCodexDependencies, activateCodexDependencies, restoreCodexDependencies, finishCodexDependencies, verifyDependencySource, installedSdkVersion, approvedSdk, validateDependencyLock, dependencyGraphDigest } from "../src/maintenance/update_dependencies.js";
import { runUpdateProcess } from "../src/maintenance/update_install.js";
import { tarFixture } from "./helpers/tar_fixture.mjs";

const sdk = { version: "0.162.1", integrity: `sha512-${Buffer.alloc(64).toString("base64")}` };
const lock = (version = "0.151.0") => ({ lockfileVersion: 3, packages: {
  "": { dependencies: { "@openai/codex-sdk": version }, devDependencies: { "@openai/codex": version } },
  "node_modules/@openai/codex-sdk": { version, integrity: sdk.integrity },
  "node_modules/@openai/codex": { version },
  "node_modules/other": { version: "1.0.0", integrity: "original" }
} });
sdk.lockSha256 = dependencyGraphDigest(lock(sdk.version));
async function writeSdk(root, version) {
  const dir = path.join(root, "node_modules/@openai/codex-sdk");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "@openai/codex-sdk", version, type: "module", main: "index.js" }));
  await fs.writeFile(path.join(dir, "index.js"), "export class Codex {}\n");
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-pair-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const pkg = { name: "fixture", dependencies: { "@openai/codex-sdk": "0.151.0" }, devDependencies: { "@openai/codex": "0.151.0" } };
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify(pkg));
  await fs.writeFile(path.join(root, "package-lock.json"), JSON.stringify(lock()));
  await fs.writeFile(path.join(root, ".gitignore"), "node_modules/\n.codex-update-deps/\n.env\ntrust.json\n");
  await fs.writeFile(path.join(root, ".env"), "SECRET=must-not-copy\n");
  await writeSdk(root, "0.151.0");
  const control = await fs.mkdtemp(path.join(os.tmpdir(), "codex-control-"));
  t.after(() => fs.rm(control, { recursive: true, force: true }));
  const config = { maintenanceControlDir: control, codexUpdateAppRoot: root, codexUpdateTrustFile: path.join(root, "trust.json") };
  await fs.writeFile(config.codexUpdateTrustFile, JSON.stringify({ artifacts: [{ ...tarFixture().entry, version: sdk.version, sdk }] }), { mode: 0o600 });
  for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]]) {
    await runUpdateProcess("git", args, { cwd: root });
  }
  const calls = [];
  const run = async (cmd, args, options) => {
    calls.push({ cmd, args, options });
    if (cmd === "/usr/bin/bwrap") return { stdout: "isolated fixture passed" };
    if (cmd !== "npm") return runUpdateProcess(cmd, args, options);
    assert.equal(options.env.HOME.startsWith(path.join(control, "dependencies")), true);
    assert.equal(options.env.CODEX_HOME, options.env.HOME);
    assert.equal(options.env.TELEGRAM_BOT_TOKEN, undefined);
    assert.equal(options.env.NODE_OPTIONS, undefined);
    assert.equal(options.env.npm_config_ignore_scripts, "true");
    await assert.rejects(fs.access(path.join(options.cwd, ".env")), { code: "ENOENT" });
    if (args[0] === "install") await fs.writeFile(path.join(options.cwd, "package-lock.json"), JSON.stringify(lock(sdk.version)));
    if (args[0] === "ci") await writeSdk(options.cwd, sdk.version);
    return { stdout: "passed\n" };
  };
  return { root, config, state: { id: randomUUID(), target: sdk.version, sdk }, calls, run };
}

test("paired preparation isolates credentials, verifies and leaves the running installation unchanged", async (t) => {
  const f = await fixture(t);
  const tx = await stageCodexDependencies(f.config, f.state, f.run);
  assert.equal(await installedSdkVersion(f.root), "0.151.0");
  assert.equal(tx.version, sdk.version);
  assert.deepEqual(f.calls.filter((c) => c.cmd === "npm").map((c) => c.args[0]), ["install", "ci", "audit"]);
  await activateCodexDependencies(f.root, tx);
  assert.equal(await installedSdkVersion(f.root), sdk.version);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.root, "package.json"))).dependencies["@openai/codex-sdk"], sdk.version);
  await restoreCodexDependencies(f.root, tx);
  await restoreCodexDependencies(f.root, tx);
  assert.equal(await installedSdkVersion(f.root), "0.151.0");
  assert.equal(JSON.parse(await fs.readFile(path.join(f.root, "package-lock.json"))).packages["node_modules/@openai/codex-sdk"].version, "0.151.0");
  await finishCodexDependencies(f.root, tx);
  await fs.access(path.join(tx.directory, "verification.log"));
  await assert.rejects(fs.access(path.join(tx.directory, "backup")), { code: "ENOENT" });
});

for (const boundary of ["before-modules", "old-modules-moved", "new-modules-moved", "one-manifest"]) {
  test(`recovery restores both manifests and modules after crash at ${boundary}`, async (t) => {
    const f = await fixture(t), tx = await stageCodexDependencies(f.config, f.state, f.run);
    if (boundary !== "before-modules") await fs.rename(path.join(f.root, "node_modules"), path.join(tx.directory, "backup/node_modules"));
    if (["new-modules-moved", "one-manifest"].includes(boundary)) await fs.rename(path.join(tx.directory, "project/node_modules"), path.join(f.root, "node_modules"));
    if (boundary === "one-manifest") await fs.copyFile(path.join(tx.directory, "project/package.json"), path.join(f.root, "package.json"));
    await restoreCodexDependencies(f.root, tx);
    await restoreCodexDependencies(f.root, tx);
    assert.equal(await installedSdkVersion(f.root), "0.151.0");
    await verifyDependencySource(f.root, tx, f.run);
  });
}

test("changed SDK approval fails before npm or source staging", async (t) => {
  const f = await fixture(t);
  await assert.rejects(stageCodexDependencies(f.config, { ...f.state, sdk: { ...sdk, version: "0.162.0" } }, f.run), /approval changed/);
  assert.equal(f.calls.length, 0);
});

test("missing SDK trust and malformed integrity are rejected", async (t) => {
  const f = await fixture(t);
  for (const entry of [undefined, { ...sdk, integrity: "sha512-wrong" }, { ...sdk, version: "latest" }]) {
    await fs.writeFile(f.config.codexUpdateTrustFile, JSON.stringify({ artifacts: [{ ...tarFixture().entry, version: sdk.version, sdk: entry }] }));
    await assert.rejects(approvedSdk(f.config, sdk.version), /independently reviewed SDK/);
  }
});

test("unapproved SDK integrity is rejected before installation or test execution", async (t) => {
  const f = await fixture(t);
  await assert.rejects(stageCodexDependencies(f.config, f.state, async (cmd, args, options) => {
    const out = await f.run(cmd, args, options);
    if (cmd === "npm" && args[0] === "install") {
      const next = lock(sdk.version); next.packages["node_modules/@openai/codex-sdk"].integrity = "wrong";
      await fs.writeFile(path.join(options.cwd, "package-lock.json"), JSON.stringify(next));
    }
    return out;
  }), /integrity/);
  assert.equal(f.calls.some((c) => c.cmd === "npm" && c.args[0] === "ci"), false);
  assert.equal(await installedSdkVersion(f.root), "0.151.0");
});

test("unrelated dependency changes and wrong CLI are rejected", () => {
  const next = lock(sdk.version);
  next.packages["node_modules/other"].version = "2.0.0";
  assert.throws(() => validateDependencyLock(lock(), next, sdk, sdk.version), /dependency graph integrity/);
  assert.throws(() => validateDependencyLock(lock(), lock(sdk.version), sdk, "0.163.0"), /versions/);
});

test("failed tests remove preparation and preserve installed files", async (t) => {
  const f = await fixture(t);
  await assert.rejects(stageCodexDependencies(f.config, f.state, async (cmd, args, options) => {
    if (cmd === "/usr/bin/bwrap" && args.includes("lint")) throw new Error("regression failed");
    return f.run(cmd, args, options);
  }), /regression failed/);
  assert.equal(await installedSdkVersion(f.root), "0.151.0");
  assert.deepEqual(await fs.readdir(path.join(f.config.maintenanceControlDir, "dependencies")), []);
});

test("changed source while waiting blocks activation", async (t) => {
  const f = await fixture(t), tx = await stageCodexDependencies(f.config, f.state, f.run);
  await fs.appendFile(path.join(f.root, ".gitignore"), "new-change\n");
  await assert.rejects(verifyDependencySource(f.root, tx, f.run), /Commit tracked/);
  assert.equal(await installedSdkVersion(f.root), "0.151.0");
});

test("tampered staged manifest and external transaction path are rejected", async (t) => {
  const f = await fixture(t), tx = await stageCodexDependencies(f.config, f.state, f.run);
  await fs.appendFile(path.join(tx.directory, "project/package.json"), " ");
  await assert.rejects(activateCodexDependencies(f.root, tx), /manifest changed/);
  await assert.rejects(restoreCodexDependencies(f.root, { ...tx, directory: os.tmpdir() }), /transaction path/);
  assert.equal(await installedSdkVersion(f.root), "0.151.0");
});

test("updater can load its environment parser when a crash leaves node_modules only in backup", async (t) => {
  const { loadUpdateDotenv } = await import("../src/maintenance/update_bootstrap.js");
  const f = await fixture(t);
  const dir = path.join(f.config.maintenanceControlDir, "dependencies", `run-${f.state.id}`, "backup/node_modules/dotenv/lib");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "../package.json"), JSON.stringify({ type: "commonjs" }));
  await fs.writeFile(path.join(dir, "main.js"), 'module.exports = { parse: () => ({ fixture: "backup" }) };');
  const dotenv = await loadUpdateDotenv(f.root, f.state.id, f.config.maintenanceControlDir);
  assert.equal(dotenv.parse().fixture, "backup");
  await assert.rejects(loadUpdateDotenv(f.root, "../../escape"), /run ID/);
});

test("unavailable namespace isolation stops before npm or candidate execution", async (t) => {
  const f = await fixture(t);
  const run = async (command, args, options) => {
    if (command === "/usr/bin/bwrap") {
      assert.ok(args.includes("--unshare-all"));
      assert.ok(args.includes("--ro-bind"));
      throw new Error("isolation denied");
    }
    assert.notEqual(command, "npm");
    return f.run(command, args, options);
  };
  await assert.rejects(stageCodexDependencies(f.config, f.state, run), /isolation denied/);
  assert.equal(await installedSdkVersion(f.root), "0.151.0");
  assert.deepEqual(await fs.readdir(path.join(f.config.maintenanceControlDir, "dependencies")), []);
});

test("post-verification module mutation blocks activation before moving the live dependencies", async (t) => {
  const f = await fixture(t), tx = await stageCodexDependencies(f.config, f.state, f.run);
  await fs.appendFile(path.join(tx.directory, "project/node_modules/@openai/codex-sdk/index.js"), "// modified after verification\n");
  await assert.rejects(activateCodexDependencies(f.root, tx), /tree changed/);
  assert.equal(await installedSdkVersion(f.root), "0.151.0");
  await assert.rejects(fs.access(path.join(tx.directory, "backup/node_modules")));
});
