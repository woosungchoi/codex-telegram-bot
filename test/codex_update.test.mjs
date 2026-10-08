import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readConfig } from "../src/config.js";
import { textFor } from "../src/i18n.js";
import { createCodexUpdateController } from "../src/maintenance/update_controller.js";
import { codexInstallation, latestCodexVersion, newerVersion, stageCodexRelease } from "../src/maintenance/update_install.js";
import { runCodexUpdate } from "../src/maintenance/update_runner.js";
import { claimUpdate, readUpdateState, releaseUpdate, updateAdmissionPaused, updateLockPath, writeUpdateState } from "../src/maintenance/update_state.js";

import { tarFixture } from "./helpers/tar_fixture.mjs";

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-update-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const config = {
    codexUpdateDir: path.join(dir, "state"), codexUpdateHome: path.join(dir, "home"),
    codexWorkerMode: "sidecar", codexUpdateAdminUserIds: new Set(["42"]),
    codexUpdateBotService: "bot.service", codexUpdateWorkerService: "worker.service",
    codexUpdateAppServerService: "app.service"
  };
  const root = path.join(config.codexUpdateHome, "packages", "standalone");
  const old = path.join(root, "releases", "0.158.0-linux"), release = path.join(root, "releases", "0.159.0-linux");
  for (const item of [old, release]) {
    await fs.mkdir(path.join(item, "bin"), { recursive: true });
    await fs.writeFile(path.join(item, "bin", "codex"), "fake CLI", { mode: 0o700 });
  }
  const bin = path.join(dir, "codex");
  await fs.symlink(path.join(old, "bin", "codex"), bin);
  await fs.symlink(old, path.join(root, "current"));
  config.codexPath = bin;
  const installation = { bin, real: path.join(old, "bin", "codex"), root, current: "0.158.0", supported: true };
  const state = { id: randomUUID(), unit: "test-update.service", phase: "launching", target: "0.159.0", installation };
  const calls = [];
  let workerBusy = false, failVerify = false, failRollback = false;
  const run = async (command, args) => {
    calls.push([command, ...args]);
    if (command === "systemctl") {
      if (args[1] === "is-active" && args[2] === "app.service") throw Object.assign(new Error("inactive"), { code: 3 });
      if (args[1] === "restart" && failRollback && (await readUpdateState(config)).phase === "rolling_back") throw new Error("restore restart failed");
      return { stdout: "active\n" };
    }
    if (args[0] === "--version") {
      if (failVerify && (await readUpdateState(config)).phase === "verifying") throw new Error("CLI validation failed");
      return { stdout: `codex-cli ${(await fs.realpath(command)).includes("0.159.0") ? "0.159.0" : "0.158.0"}\n` };
    }
    throw new Error("Unexpected process in test.");
  };
  let time = 1000;
  const deps = {
    run, stage: async () => release,
    workerStatus: async () => ({ status: "ok", activeJobs: workerBusy ? [{}] : [], runningJobIds: workerBusy ? ["job"] : [] }),
    now: () => time, stableIdleMs: 1000, idleTimeoutMs: 4000,
    sleep: async () => {
      time += 1000;
      await fs.writeFile(path.join(config.codexUpdateDir, "idle.json"), JSON.stringify({ id: state.id, idle: true, at: time }));
    }
  };
  return { config, state, dir, old, release, calls, deps,
    busy: () => { workerBusy = true; },
    failVerify: () => { failVerify = true; }, failRollback: () => { failRollback = true; }
  };
}

test("update config ignores account CODEX_HOME and enforces administrator allowlist", () => {
  const env = { HOME: "/home/test", TELEGRAM_BOT_TOKEN: "123:token", ALLOWED_USER_IDS: "42", CODEX_HOME: "/accounts/one" };
  const config = readConfig(env, { appRoot: "/bot" });
  assert.equal(config.codexUpdateHome, "/home/test/.codex");
  assert.deepEqual([...config.codexUpdateAdminUserIds], ["42"]);
  assert.equal(readConfig({ ...env, ALLOWED_USER_IDS: "42,43" }).codexUpdateAdminUserIds.size, 0);
  assert.throws(() => readConfig({ ...env, CODEX_UPDATE_ADMIN_USER_IDS: "99" }), /allowed users/);
  assert.equal(readConfig({ ...env, CODEX_PATH: "/bot/bin/codex-yolo", CODEX_REAL_PATH: "/host/bin/codex" }).codexUpdateBin, "/host/bin/codex");
});

test("latest release parsing rejects prereleases, downgrade and malformed metadata", async () => {
  assert.equal(await latestCodexVersion(async () => ({ stdout: JSON.stringify({ tag_name: "rust-v0.159.0" }) })), "0.159.0");
  for (const metadata of [{ tag_name: "rust-v0.160.0-alpha.1" }, { tag_name: "rust-v0.160.0", prerelease: true }, { version: "0.159.0" }]) {
    await assert.rejects(latestCodexVersion(async () => ({ stdout: JSON.stringify(metadata) })));
  }
  assert.equal(newerVersion("0.159.0", "0.158.0"), true);
  assert.equal(newerVersion("0.159.0", "0.159.0"), false);
  assert.equal(newerVersion("0.159.0", "0.160.0"), false);
});

test("host update lock serializes simultaneous requests and prevents wrong-owner release", async (t) => {
  const f = await fixture(t);
  assert.equal(await claimUpdate(f.config, f.state), true);
  assert.equal(await claimUpdate(f.config, { ...f.state, id: randomUUID() }), false);
  await assert.rejects(releaseUpdate(f.config, "other"), /owner mismatch/);
  await releaseUpdate(f.config, f.state.id);
});

test("a bounded deployment pause works without an update run and expires safely", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(f.config.codexUpdateDir);
  const file = path.join(f.config.codexUpdateDir, "deployment-pause.json");
  await fs.writeFile(file, JSON.stringify({ id: "reload", expiresAt: Date.now() + 60_000 }));
  assert.equal(updateAdmissionPaused(f.config), true);
  await fs.writeFile(file, JSON.stringify({ id: "reload", expiresAt: Date.now() - 1000 }));
  assert.equal(updateAdmissionPaused(f.config), false);
});

test("staging verifies the approved artifact before execution without changing the live CLI", async (t) => {
  const f = await fixture(t), calls = [];
  const { archive, entry } = tarFixture();
  f.config.codexUpdateTrustFile = path.join(f.dir, "trust.json");
  await fs.writeFile(f.config.codexUpdateTrustFile, JSON.stringify({ artifacts: [entry] }), { mode: 0o600 });
  const before = await fs.readlink(f.config.codexPath);
  const release = await stageCodexRelease(f.config, { ...f.state, target: entry.version }, async (command, args, options) => {
    calls.push({ command, args, options });
    if (command === "curl") await fs.writeFile(args.at(-1), archive);
    else assert.equal(await fs.readFile(command, "utf8"), "verified executable");
    return { stdout: `codex-cli ${entry.version}` };
  });
  const execute = calls.find((c) => c.command !== "curl");
  assert.equal(calls.length, 2);
  assert.notEqual(execute.options.env.CODEX_HOME, f.config.codexUpdateHome);
  assert.equal(execute.options.env.CODEX_HOME, execute.options.env.HOME);
  assert.equal(execute.options.env.CODEX_API_KEY, undefined);
  assert.equal(await fs.readFile(path.join(release, "bin", "codex"), "utf8"), "verified executable");
  assert.equal(await fs.readlink(f.config.codexPath), before);
});

test("successful update switches both links only after idle and verifies services", async (t) => {
  const f = await fixture(t);
  await claimUpdate(f.config, f.state);
  const result = await runCodexUpdate(f.config, f.state.id, f.deps);
  assert.equal(result.phase, "succeeded");
  assert.equal(await fs.realpath(f.config.codexPath), path.join(f.release, "bin", "codex"));
  assert.equal(await fs.readlink(path.join(f.state.installation.root, "current")), f.release);
  const actions = f.calls.filter(([cmd]) => cmd === "systemctl").map((entry) => entry.slice(2).join(":"));
  assert.ok(actions.indexOf("stop:bot.service") < actions.indexOf("restart:worker.service"));
  assert.equal(updateAdmissionPaused(f.config), false);
  await assert.rejects(fs.access(updateLockPath(f.config)), { code: "ENOENT" });
  assert.equal((await runCodexUpdate(f.config, f.state.id, f.deps)).phase, "succeeded");
});

test("updater waits for a restarted worker socket before starting the bot or rolling back", async (t) => {
  const f = await fixture(t);
  await claimUpdate(f.config, f.state);
  let checks = 0;
  const result = await runCodexUpdate(f.config, f.state.id, {
    ...f.deps,
    workerStatus: async () => {
      const restarted = f.calls.some(([cmd, , action, unit]) => cmd === "systemctl" && action === "restart" && unit === "worker.service");
      if (restarted) {
        checks += 1;
        if (checks <= 2) {
          assert.equal(f.calls.some(([cmd, , action, unit]) => cmd === "systemctl" && action === "restart" && unit === "bot.service"), false);
          throw Object.assign(new Error("socket starting"), { code: checks === 1 ? "ENOENT" : "ECONNREFUSED" });
        }
      }
      return { status: "ok", activeJobs: [], runningJobIds: [] };
    }
  });
  assert.equal(result.phase, "succeeded");
  assert.ok(checks >= 3);
  assert.equal(result.error, undefined);
});

test("a worker that never becomes ready on the new release triggers a bounded rollback", async (t) => {
  const f = await fixture(t);
  await claimUpdate(f.config, f.state);
  const result = await runCodexUpdate(f.config, f.state.id, {
    ...f.deps, workerReadyTimeoutMs: 3000,
    workerStatus: async () => {
      if ((await readUpdateState(f.config)).phase === "verifying") {
        throw Object.assign(new Error("new worker socket unavailable"), { code: "ENOENT" });
      }
      return { status: "ok", activeJobs: [], runningJobIds: [] };
    }
  });
  assert.equal(result.phase, "rolled_back");
  assert.match(result.error, /did not become ready within 3000ms/);
  assert.equal(await fs.realpath(f.config.codexPath), f.state.installation.real);
  assert.equal(updateAdmissionPaused(f.config), false);
});

test("busy worker timeout leaves jobs, services and original CLI untouched", async (t) => {
  const f = await fixture(t); f.busy();
  await claimUpdate(f.config, f.state);
  const result = await runCodexUpdate(f.config, f.state.id, f.deps);
  assert.equal(result.phase, "failed");
  assert.match(result.error, /no jobs were stopped/);
  assert.equal(await fs.realpath(f.config.codexPath), f.state.installation.real);
  assert.equal(f.calls.some(([cmd, , action]) => cmd === "systemctl" && ["stop", "restart"].includes(action)), false);
});

test("verification failure restores both selection links and restarts prior services", async (t) => {
  const f = await fixture(t); f.failVerify();
  await fs.writeFile(path.join(f.state.installation.root, "auto-update-version"), "0.158.0-linux");
  await claimUpdate(f.config, f.state);
  const result = await runCodexUpdate(f.config, f.state.id, f.deps);
  assert.equal(result.phase, "rolled_back");
  assert.equal(await fs.readlink(f.config.codexPath), f.state.installation.real);
  assert.equal(await fs.readlink(path.join(f.state.installation.root, "current")), f.old);
  assert.equal(updateAdmissionPaused(f.config), false);
  assert.equal(await fs.readFile(path.join(f.state.installation.root, "auto-update-version"), "utf8"), "0.158.0-linux");
});

test("a crash after requesting bot stop resumes it before retrying preparation", async (t) => {
  const f = await fixture(t);
  await claimUpdate(f.config, f.state);
  await writeUpdateState(f.config, { ...f.state, phase: "waiting_idle", botStopRequested: true });
  const result = await runCodexUpdate(f.config, f.state.id, { ...f.deps,
    stage: async () => { throw new Error("download failed"); }
  });
  assert.equal(result.phase, "failed");
  assert.deepEqual(f.calls[0], ["systemctl", "--user", "start", "bot.service"]);
});

test("failed rollback keeps admission paused and the run available for recovery", async (t) => {
  const f = await fixture(t); f.failVerify(); f.failRollback();
  await claimUpdate(f.config, f.state);
  const result = await runCodexUpdate(f.config, f.state.id, f.deps);
  assert.equal(result.phase, "rollback_failed");
  assert.equal(updateAdmissionPaused(f.config), true);
  await fs.access(updateLockPath(f.config));
});

test("a detached updater restart restores an uncertain selection without reapplying", async (t) => {
  const f = await fixture(t);
  await claimUpdate(f.config, f.state);
  await writeUpdateState(f.config, { ...f.state, phase: "verifying", services: ["bot.service", "worker.service"],
    previousLinks: { bin: f.state.installation.real, current: f.old } });
  await fs.unlink(f.config.codexPath);
  await fs.symlink(path.join(f.release, "bin", "codex"), f.config.codexPath);
  const result = await runCodexUpdate(f.config, f.state.id, { ...f.deps, stage: async () => { throw new Error("must not stage"); } });
  assert.equal(result.phase, "rolled_back");
  assert.equal(await fs.realpath(f.config.codexPath), f.state.installation.real);
});

test("installation inspection rejects a profile binary outside canonical host home", async (t) => {
  const f = await fixture(t);
  assert.equal((await codexInstallation(f.config, f.deps.run)).supported, true);
  assert.equal((await codexInstallation({ ...f.config, codexUpdateHome: path.join(f.dir, "another-account") }, f.deps.run)).supported, false);
});

test("wrapper updates select the real CLI and reject a mismatching runtime version", async (t) => {
  const f = await fixture(t);
  const config = { ...f.config, codexPath: "/bot/bin/codex-yolo", codexUpdateBin: f.config.codexPath,
    codexUpdateWrapperRealPath: f.config.codexPath };
  const inspect = (version) => codexInstallation(config, async (command, args, options) => {
    if (command === config.codexPath) {
      assert.equal(options.env.CODEX_REAL_PATH, f.config.codexPath);
      return { stdout: `codex-cli ${version}` };
    }
    return f.deps.run(command, args);
  });
  assert.equal((await inspect("0.158.0")).supported, true);
  assert.equal((await inspect("0.157.0")).supported, false);
});

async function controllerFixture(t, { latest = "0.159.0" } = {}) {
  const f = await fixture(t);
  const { entry } = tarFixture();
  f.config.codexUpdateTrustFile = path.join(f.dir, "trust.json");
  await fs.writeFile(f.config.codexUpdateTrustFile, JSON.stringify({ artifacts: [{ ...entry, version: latest }] }), { mode: 0o600 });
  const edits = [], launches = [];
  let active = false, clock = 1000;
  const controller = createCodexUpdateController({
    config: f.config, appRoot: f.dir, text: (key) => textFor("ko", key), language: () => "ko",
    now: () => clock, inspect: async () => f.state.installation, latest: async () => latest,
    telegram: { getChatKey: () => "-100:topic:7", editOrReplyHtml: async (...args) => edits.push(args) },
    keyboards: { inline: (rows) => rows, withClose: (value) => value },
    run: async (command, args) => {
      if (command === "systemd-run") { launches.push(args); active = true; return { stdout: "" }; }
      if (args.includes("--property=WorkingDirectory")) return { stdout: f.dir };
      if (args.includes("is-active")) {
        if (active) return { stdout: "active" };
        throw Object.assign(new Error("inactive"), { code: 3 });
      }
      return { stdout: "" };
    }
  });
  const ctx = { from: { id: 42 }, chat: { id: -100, type: "supergroup" }, botInfo: { id: 123 },
    callbackQuery: { message: { message_id: 88, message_thread_id: 7 } } };
  return { ...f, controller, ctx, edits, launches, expire: () => { clock += 601_000; } };
}

test("panel preview is bound to administrator and message, with exact topic stored at launch", async (t) => {
  const f = await controllerFixture(t);
  await f.controller.handle(f.ctx, "codex_update");
  const id = f.edits.at(-1)[2][0][0].callback_data.split(":").at(-1);
  assert.ok(f.edits.at(-1)[2][0][0].callback_data.length <= 64);
  await f.controller.handle({ ...f.ctx, from: { id: 99 } }, "codex_update_start", id);
  await f.controller.handle({ ...f.ctx, callbackQuery: { message: { message_id: 89 } } }, "codex_update_start", id);
  assert.equal(f.launches.length, 0);
  await f.controller.handle(f.ctx, "codex_update_start", id);
  await f.controller.handle(f.ctx, "codex_update_start", id);
  assert.equal(f.launches.length, 1);
  assert.deepEqual((await readUpdateState(f.config)).origin, { botId: "123", chatId: "-100", threadId: "7", messageId: "88" });
});

test("update cannot launch without a durable panel message ID", async (t) => {
  const f = await controllerFixture(t);
  const ctx = { ...f.ctx, callbackQuery: { message: { message_thread_id: 7 } } };
  await f.controller.handle(ctx, "codex_update");
  const id = f.edits.at(-1)[2][0][0].callback_data.split(":").at(-1);
  await f.controller.handle(ctx, "codex_update_start", id);
  assert.equal(f.launches.length, 0);
  assert.match(f.edits.at(-1)[1], /panel message ID required/);
});

test("latest version and expired preview never launch an updater", async (t) => {
  const current = await controllerFixture(t, { latest: "0.158.0" });
  await current.controller.handle(current.ctx, "codex_update");
  assert.ok(current.edits.at(-1)[2].every((row) => !row[0].callback_data.includes("start")));
  assert.equal(current.launches.length, 0);
  const expired = await controllerFixture(t);
  await expired.controller.handle(expired.ctx, "codex_update");
  const id = expired.edits.at(-1)[2][0][0].callback_data.split(":").at(-1);
  expired.expire();
  await expired.controller.handle(expired.ctx, "codex_update_start", id);
  assert.equal(expired.launches.length, 0);
});

test("update panel without approved trust shows no executable update button", async (t) => {
  const f = await controllerFixture(t);
  await fs.unlink(f.config.codexUpdateTrustFile);
  await f.controller.handle(f.ctx, "codex_update");
  assert.ok(f.edits.at(-1)[2].every((row) => !row[0].callback_data.includes("start")));
  assert.equal(f.launches.length, 0);
});
