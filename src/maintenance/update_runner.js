import { stageCodexDependencies, verifyDependencySource, activateCodexDependencies, restoreCodexDependencies, finishCodexDependencies, installedSdkVersion } from "./update_dependencies.js";
import fs from "node:fs/promises";
import path from "node:path";
import { writePrivateFileAtomic } from "../fs/private.js";
import { createWorkerClient } from "../worker/client.js";
import { waitForWorkerReady } from "../worker/readiness.js";
import { atomicSymlink, codexInstallation, runUpdateProcess, stageCodexRelease, versionFromOutput } from "./update_install.js";
import { readUpdateState, releaseUpdate, updateLockPath, UPDATE_TERMINAL_PHASES, writeUpdateState } from "./update_state.js";

export function validateServiceName(name) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.@-]*\.service$/.test(name)) throw new Error("Invalid update service name.");
  return name;
}

export async function runCodexUpdate(config, id, {
  run = runUpdateProcess,
  stage = stageCodexRelease,
  installation = codexInstallation,
  dependencies = { stage: stageCodexDependencies, verify: verifyDependencySource, activate: activateCodexDependencies, restore: restoreCodexDependencies, finish: finishCodexDependencies, version: installedSdkVersion },
  workerStatus = () => createWorkerClient(config).status(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  idleTimeoutMs = 30 * 60_000,
  stableIdleMs = 5000,
  workerReadyTimeoutMs = 30_000
} = {}) {
  let state = await readUpdateState(config);
  if (!state || state.id !== id) throw new Error("Update run does not own current status.");
  if (UPDATE_TERMINAL_PHASES.has(state.phase)) {
    if (state.dependencies) await dependencies.finish(config.codexUpdateAppRoot, state.dependencies).catch(() => {});
    await releaseUpdate(config, id);
    return state;
  }
  const owner = JSON.parse(await fs.readFile(path.join(updateLockPath(config), "owner.json"), "utf8"));
  if (owner.id !== id) throw new Error("Update lock owner mismatch.");
  const setPhase = async (phase, patch = {}) => {
    state = await writeUpdateState(config, { ...state, ...patch, phase });
  };
  const service = (action, unit) => run("systemctl", ["--user", action, validateServiceName(unit)], { timeout: 90_000 });
  const isActive = async (unit) => {
    try { return (await service("is-active", unit)).stdout.trim() === "active"; }
    catch (error) { if (typeof error.code === "number") return false; throw error; }
  };
  const workerIdle = async () => {
    if (config.codexWorkerMode !== "sidecar") return true;
    const status = await workerStatus();
    return Array.isArray(status.activeJobs) && Array.isArray(status.runningJobIds)
      && status.activeJobs.length === 0 && status.runningJobIds.length === 0;
  };
  const restartServices = async () => {
    for (const unit of state.services.filter((item) => item !== config.codexUpdateBotService)) {
      await service("restart", unit);
      if (unit === config.codexUpdateWorkerService && config.codexWorkerMode === "sidecar") {
        await waitForWorkerReady({ status: workerStatus }, {
          timeoutMs: workerReadyTimeoutMs, sleep, now
        });
      }
    }
    await service("restart", config.codexUpdateBotService);
    for (const unit of state.services) {
      if (!await isActive(unit)) throw new Error(`Service did not start: ${unit}`);
    }
    if (config.codexWorkerMode === "sidecar") await workerStatus();
  };
  const restore = async () => {
    await setPhase("rolling_back");
    if (state.dependencies) {
      await service("stop", config.codexUpdateBotService);
      if (config.codexWorkerMode === "sidecar") await service("stop", config.codexUpdateWorkerService);
      await dependencies.restore(config.codexUpdateAppRoot, state.dependencies);
    }
    await atomicSymlink(state.installation.bin, state.previousLinks.bin);
    await atomicSymlink(path.join(state.installation.root, "current"), state.previousLinks.current);
    if (Object.hasOwn(state.previousLinks, "autoUpdateVersion")) {
      const marker = path.join(state.installation.root, "auto-update-version");
      if (state.previousLinks.autoUpdateVersion === null) await fs.rm(marker, { force: true });
      else await writePrivateFileAtomic(marker, state.previousLinks.autoUpdateVersion);
    }
    await restartServices();
    const current = versionFromOutput((await run(state.installation.bin, ["--version"], { timeout: 10_000 })).stdout);
    if (current !== state.installation.current) throw new Error("Rollback version verification failed.");
  };
  // Restarted detached services never repeat an uncertain selection. Restore
  // the persisted original links, then report the interrupted update.
  let selectionStarted = Boolean(state.previousLinks);
  let botStopped = false;
  try {
    if (selectionStarted) throw new Error("Interrupted update; restoring the previous version.");
    if (state.botStopRequested) {
      await service("start", config.codexUpdateBotService);
      await setPhase("launching", { botStopRequested: false });
    }
    const observed = await installation(config, run);
    if (!observed.supported || observed.real !== state.installation.real || observed.current !== state.installation.current) {
      throw new Error("Codex installation changed since approval; check again.");
    }
    const services = [config.codexUpdateBotService];
    if (!await isActive(config.codexUpdateBotService)) throw new Error("Bot service must be running before update.");
    if (config.codexWorkerMode === "sidecar") {
      if (!await isActive(config.codexUpdateWorkerService)) throw new Error("Worker service is not running.");
      services.push(config.codexUpdateWorkerService);
    }
    for (const unit of services) {
      const directory = (await run("systemctl", ["--user", "show", unit, "--property=WorkingDirectory", "--value"], { timeout: 10_000 })).stdout.trim();
      if (path.resolve(directory) !== config.codexUpdateAppRoot) throw new Error("Paired update services must use the same application directory.");
    }
    if (await isActive(config.codexUpdateAppServerService)) services.push(config.codexUpdateAppServerService);
    await setPhase("downloading", { services });
    if (!state.sdk) throw new Error("This update predates paired SDK approval; create a new update preview.");
    const release = await stage(config, state, run);
    const prepared = await dependencies.stage(config, state, run);
    await setPhase("waiting_idle", { release, dependencies: prepared });
    const started = now();
    let idleSince = null;
    while (now() - started < idleTimeoutMs) {
      let ack = null;
      try { ack = JSON.parse(await fs.readFile(path.join(config.codexUpdateDir, "idle.json"), "utf8")); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      const idle = ack?.id === id && ack.idle === true && now() - ack.at >= 0 && now() - ack.at < 3000 && await workerIdle();
      if (idle) {
        idleSince ??= now();
        if (now() - idleSince >= stableIdleMs) break;
      } else { idleSince = null; }
      await sleep(1000);
    }
    if (idleSince === null || now() - idleSince < stableIdleMs) throw new Error("Timed out waiting for jobs and final delivery; no jobs were stopped.");
    const beforeSwitch = await installation(config, run);
    if (beforeSwitch.real !== state.installation.real) throw new Error("Installation changed while waiting for idle.");
    await dependencies.verify(config.codexUpdateAppRoot, state.dependencies, run);
    // Persist both selections before activation; recovery restores the CLI and
    // dependency tree together. User settings, accounts and databases stay intact.
    const previousLinks = {
      bin: await fs.readlink(state.installation.bin),
      current: await fs.readlink(path.join(state.installation.root, "current")),
      autoUpdateVersion: await fs.readFile(path.join(state.installation.root, "auto-update-version"), "utf8").catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      })
    };
    await setPhase("waiting_idle", { botStopRequested: true });
    await service("stop", config.codexUpdateBotService);
    botStopped = true;
    if (!await workerIdle()) throw new Error("A worker job started before activation; update aborted.");
    await setPhase("switching", { previousLinks });
    selectionStarted = true;
    if (config.codexWorkerMode === "sidecar") await service("stop", config.codexUpdateWorkerService);
    await dependencies.activate(config.codexUpdateAppRoot, state.dependencies);
    await atomicSymlink(path.join(state.installation.root, "current"), release);
    await atomicSymlink(state.installation.bin, path.join(release, "bin", "codex"));
    if (previousLinks.autoUpdateVersion !== null) {
      await writePrivateFileAtomic(path.join(state.installation.root, "auto-update-version"), path.basename(release));
    }
    await setPhase("verifying");
    await restartServices();
    if (versionFromOutput((await run(state.installation.bin, ["--version"], { timeout: 10_000 })).stdout) !== state.target) {
      throw new Error("Activated Codex version mismatch.");
    }
    if (services.includes(config.codexUpdateAppServerService)) {
      const pid = (await run("systemctl", ["--user", "show", config.codexUpdateAppServerService, "--property=MainPID", "--value"], { timeout: 10_000 })).stdout.trim();
      if (!/^[1-9]\d*$/.test(pid) || versionFromOutput((await run(`/proc/${pid}/exe`, ["--version"], { timeout: 10_000 })).stdout) !== state.target) {
        throw new Error("App-server did not load the updated executable.");
      }
    }
    if (await dependencies.version(config.codexUpdateAppRoot) !== state.sdk.version) throw new Error("Activated SDK version mismatch.");
    await setPhase("succeeded", { sdkVersion: state.sdk.version, completedAt: new Date().toISOString() });
  } catch (error) {
    const failure = String(error.message).slice(0, 1500);
    try {
      if (selectionStarted) await restore();
      else if (botStopped || state.botStopRequested) await service("start", config.codexUpdateBotService);
      await setPhase(selectionStarted ? "rolled_back" : "failed", { error: failure, completedAt: new Date().toISOString() });
    } catch (rollbackError) {
      await setPhase("rollback_failed", { error: failure, rollbackError: String(rollbackError.message).slice(0, 1500) });
    }
  }
  if (UPDATE_TERMINAL_PHASES.has(state.phase)) {
    if (state.dependencies) await dependencies.finish(config.codexUpdateAppRoot, state.dependencies).catch(() => {});
    await releaseUpdate(config, id);
    await fs.rm(path.join(config.codexUpdateDir, "runs", id, "stage-home"), { recursive: true, force: true }).catch(() => {});
  }
  return state;
}
