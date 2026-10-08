import { approvedArtifact, extractApprovedBinary } from "./update_artifact.js";
import { buildCodexChildEnv } from "../codex/child_env.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const runUpdateProcess = promisify(execFile);
const LATEST_URL = "https://releases.openai.com/codex/channels/latest";
export const STABLE_VERSION = /^\d+\.\d+\.\d+$/;

export function versionFromOutput(output) {
  const match = /^codex-cli (\d+\.\d+\.\d+(?:-[\w.]+)?)/m.exec(output);
  if (!match) throw new Error("Cannot read Codex CLI version.");
  return match[1];
}

export function newerVersion(latest, current) {
  if (!STABLE_VERSION.test(latest)) return false;
  const a = latest.split(".").map(Number), b = current.split(/[.-]/).slice(0, 3).map(Number);
  for (let i = 0; i < 3; i += 1) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return current.includes("-");
}

export async function latestCodexVersion(run = runUpdateProcess) {
  const { stdout } = await run("curl", ["--proto", "=https", "-fsSL", "--connect-timeout", "10", "--max-time", "30", LATEST_URL], { timeout: 35_000, maxBuffer: 4 * 1024 * 1024 });
  const metadata = JSON.parse(stdout);
  const version = String(metadata.tag_name || "").replace(/^rust-v/, "");
  if (!STABLE_VERSION.test(version) || metadata.prerelease || metadata.draft) throw new Error("Latest stable Codex metadata is invalid.");
  return version;
}

export async function codexInstallation(config, run = runUpdateProcess) {
  const command = config.codexUpdateBin || config.codexPath;
  let bin = command;
  if (!path.isAbsolute(bin)) {
    if (bin.includes(path.sep)) throw new Error("CODEX_PATH must be absolute or a command on PATH.");
    bin = null;
    for (const dir of (process.env.PATH || "").split(path.delimiter)) {
      const candidate = path.resolve(dir, command);
      try { await fs.access(candidate, fs.constants.X_OK); bin = candidate; break; }
      catch (error) { if (!["ENOENT", "EACCES", "ENOTDIR"].includes(error.code)) throw error; }
    }
    if (!bin) throw new Error("Codex executable was not found on PATH.");
  }
  const real = await fs.realpath(bin);
  const root = path.join(config.codexUpdateHome, "packages", "standalone");
  const { stdout } = await run(real, ["--version"], { timeout: 10_000 });
  const current = versionFromOutput(stdout);
  const runtimeEnv = buildCodexChildEnv(config.codexEnv);
  if (config.codexUpdateWrapperRealPath) runtimeEnv.CODEX_REAL_PATH = config.codexUpdateWrapperRealPath;
  const runtimeVersion = command === config.codexPath ? current
    : versionFromOutput((await run(config.codexPath, ["--version"], { timeout: 10_000, env: runtimeEnv })).stdout);
  const supported = process.platform === "linux"
    && real.startsWith(`${path.join(root, "releases")}${path.sep}`)
    && runtimeVersion === current
    && (await fs.lstat(bin)).isSymbolicLink();
  return { bin, real, root, current, supported };
}

export async function stageCodexRelease(config, state, run = runUpdateProcess) {
  if (!STABLE_VERSION.test(state.target)) throw new Error("Invalid update target.");
  // The trust file is supplied independently by the operator, never fetched
  // beside the download. No remote installer is executed, even as a fallback.
  const entry = await approvedArtifact(config, state.target);
  const runDir = await fs.mkdtemp(path.join(await fs.mkdir(config.codexUpdateDir, { recursive: true }).then(() => config.codexUpdateDir), "verified-"));
  const archive = path.join(runDir, "artifact.tar.gz");
  const release = path.join(runDir, "release");
  const bin = path.join(release, "bin", "codex");
  try {
    await run("curl", ["--proto", "=https", "--proto-redir", "=https", "-fsSL", "--connect-timeout", "10", "--max-time", "180", "--max-filesize", "268435456", entry.url, "-o", archive], { timeout: 185_000, env: buildCodexChildEnv({}, { managed: true }) });
    const executable = extractApprovedBinary(await fs.readFile(archive), entry);
    await fs.mkdir(path.dirname(bin), { recursive: true, mode: 0o700 });
    await fs.writeFile(bin, executable, { flag: "wx", mode: 0o700 });
    const env = buildCodexChildEnv({}, { managed: true, home: runDir });
    env.HOME = runDir;
    if (versionFromOutput((await run(bin, ["--version"], { timeout: 10_000, env })).stdout) !== state.target) throw new Error("Verified artifact version mismatch.");
    const destination = path.join(state.installation.root, "releases", `${state.target}-${process.platform}-${process.arch}-${entry.sha256.slice(0, 16)}`);
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    // Never execute an existing unverified destination as a shortcut.
    try { await fs.lstat(destination); throw new Error("Release destination exists; verify it independently before recovery."); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await fs.rename(release, destination);
    return destination;
  } finally { await fs.rm(runDir, { recursive: true, force: true }); }
}

export async function atomicSymlink(file, target) {
  const temp = `${file}.${randomUUID()}.tmp`;
  await fs.symlink(target, temp);
  try { await fs.rename(temp, file); }
  finally { await fs.rm(temp, { force: true }); }
}
