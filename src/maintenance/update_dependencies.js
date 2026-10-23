import { dependencyTreeDigest } from "./tree_integrity.js";
import { controlDir, signControlRecord, readControlRecord, requireControlSeparation } from "./control_receipt.js";
import { isolatedUpdateCommand, verifyIsolatedUpdate } from "./update_isolation.js";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { buildCodexChildEnv } from "../codex/child_env.js";
import { writePrivateFileAtomic } from "../fs/private.js";
import { approvedArtifact } from "./update_artifact.js";
import { runUpdateProcess, STABLE_VERSION } from "./update_install.js";

const manifests = ["package.json", "package-lock.json"];
const digest = (value) => createHash("sha256").update(value).digest("hex");
const exists = async (file) => fs.lstat(file).then(() => true, (error) => {
  if (error.code === "ENOENT") return false;
  throw error;
});

export async function installedSdkVersion(root) {
  const pkg = JSON.parse(await fs.readFile(path.join(root, "node_modules/@openai/codex-sdk/package.json"), "utf8"));
  if (pkg.name !== "@openai/codex-sdk" || !STABLE_VERSION.test(pkg.version)) throw new Error("Invalid installed Codex SDK.");
  return pkg.version;
}

export async function approvedSdk(config, target) {
  const sdk = (await approvedArtifact(config, target)).sdk;
  if (!sdk || !STABLE_VERSION.test(sdk.version) || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(sdk.integrity || "")) {
    throw new Error("Paired update requires an independently reviewed SDK version and sha512 integrity in the trust manifest.");
  }
  if (!/^[a-f0-9]{64}$/.test(sdk.lockSha256 || "")) throw new Error("Paired update requires independently approved complete lockSha256 (v2); legacy SDK-only approval is insufficient.");
  return { version: sdk.version, integrity: sdk.integrity, lockSha256: sdk.lockSha256 };
}

export function dependencyGraphDigest(lock) {
  const canonical = (v) => Array.isArray(v) ? v.map(canonical) : v && typeof v === "object"
    ? Object.fromEntries(Object.keys(v).sort().map((key) => [key, canonical(v[key])])) : v;
  return digest(JSON.stringify(canonical(lock)));
}

export function validateDependencyLock(previous, next, sdk, cliVersion) {
  const sdkPackage = next.packages?.["node_modules/@openai/codex-sdk"];
  if (sdkPackage?.version !== sdk.version || sdkPackage.integrity !== sdk.integrity
    || next.packages?.["node_modules/@openai/codex"]?.version !== cliVersion) {
    throw new Error("Prepared Codex package versions or SDK integrity do not match approval.");
  }
  if (!sdk.lockSha256 || dependencyGraphDigest(next) !== sdk.lockSha256) throw new Error("Unapproved complete dependency graph integrity (CLI, platform packages or metadata changed).");
  // A Codex update may not silently update unrelated dependencies.
  for (const key of new Set([...Object.keys(previous.packages || {}), ...Object.keys(next.packages || {})])) {
    if (!key || /^node_modules\/@openai\/codex(?:$|[-/])/.test(key)) continue;
    if (JSON.stringify(previous.packages[key]) !== JSON.stringify(next.packages[key])) {
      throw new Error(`Unrelated dependency changed: ${key}`);
    }
  }
}

async function cleanHead(root, run) {
  const status = await run("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: root, timeout: 10_000 });
  const changes = status.stdout.split("\n").filter(Boolean);
  if (changes.some((line) => !/^[ M]{2} (package\.json|package-lock\.json)$/.test(line))) {
    throw new Error("Commit tracked repository changes before updating Codex packages (only package manifest drift is allowed).");
  }
  return (await run("git", ["rev-parse", "HEAD"], { cwd: root, timeout: 10_000 })).stdout.trim();
}

function transactionPaths(root, transaction) {
  const directory = path.resolve(transaction.directory);
  if (path.dirname(directory) !== path.join(transaction.controlDirectory || "", "dependencies") || !/^run-[a-f0-9-]{36}$/.test(path.basename(directory))) {
    throw new Error("Invalid dependency transaction path.");
  }
  return { directory, staged: path.join(directory, "project"), backup: path.join(directory, "backup") };
}

export async function stageCodexDependencies(config, state, run = runUpdateProcess) {
  const root = config.codexUpdateAppRoot;
  if (!root) throw new Error("Codex dependency update requires the application root.");
  const sdk = await approvedSdk(config, state.target);
  if (JSON.stringify(sdk) !== JSON.stringify(state.sdk)) throw new Error("SDK approval changed since preview.");
  const head = await cleanHead(root, run);
  const previousVersion = await installedSdkVersion(root);
  const modules = await fs.lstat(path.join(root, "node_modules"));
  if (!modules.isDirectory() || modules.isSymbolicLink()) throw new Error("Dependency update requires a regular node_modules directory.");
  const controlDirectory = controlDir(config);
  await requireControlSeparation(controlDirectory, [root, config.codexWorkdir, ...(config.codexAdditionalDirectories || [])]);
  const base = path.join(controlDirectory, "dependencies");
  await fs.mkdir(base, { recursive: true, mode: 0o700 });
  if ((await fs.lstat(base)).isSymbolicLink()) throw new Error("Dependency staging directory must not be a symlink.");
  if (!/^[a-f0-9-]{36}$/.test(state.id || "")) throw new Error("Invalid dependency update ID.");
  const directory = path.join(base, `run-${state.id}`);
  // Preparation is repeatable; activation recovery never calls this function.
  await fs.rm(directory, { recursive: true, force: true });
  await fs.mkdir(directory, { mode: 0o700 });
  const transaction = { controlDirectory, id: state.id, approval: { trustFile: config.codexUpdateTrustFile, sdk, target: state.target }, directory, head, previousVersion, version: sdk.version, originals: {}, prepared: {} };
  const { staged, backup } = transactionPaths(root, transaction);
  try {
    await fs.mkdir(staged); await fs.mkdir(backup);
    const tracked = (await run("git", ["ls-files", "-z"], { cwd: root, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 })).stdout.split("\0").filter(Boolean);
    for (const relative of tracked) {
      if (relative.startsWith(".codex-update-deps/") || relative === ".env" || relative === ".npmrc" || relative.startsWith("state/")) throw new Error("Runtime data must not be tracked in the update source.");
      const source = path.resolve(root, relative);
      if (!source.startsWith(`${root}${path.sep}`) || !(await fs.lstat(source)).isFile()) throw new Error("Update source must contain only regular tracked files.");
      const dest = path.join(staged, relative);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(source, dest);
    }
    for (const name of manifests) {
      const content = await fs.readFile(path.join(root, name));
      transaction.originals[name] = digest(content);
      await fs.writeFile(path.join(backup, name), content, { mode: 0o600 });
    }
    const before = JSON.parse(await fs.readFile(path.join(staged, "package-lock.json"), "utf8"));
    const pkgPath = path.join(staged, "package.json");
    const pkg = JSON.parse(await fs.readFile(pkgPath, "utf8"));
    pkg.dependencies["@openai/codex-sdk"] = sdk.version;
    pkg.devDependencies["@openai/codex"] = state.target;
    await fs.writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
    const home = path.join(directory, "home");
    await fs.mkdir(home);
    const env = buildCodexChildEnv({}, { managed: true, home });
    env.HOME = home;
    env.npm_config_cache = path.join(directory, "npm-cache");
    env.npm_config_registry = "https://registry.npmjs.org";
    env.npm_config_userconfig = path.join(home, "empty-npmrc");
    env.npm_config_globalconfig = path.join(home, "empty-global-npmrc");
    env.npm_config_ignore_scripts = "true";
    const options = { cwd: staged, env, timeout: 20 * 60_000, maxBuffer: 16 * 1024 * 1024 };
    // Unsupported namespace isolation holds the update before downloading or executing candidate code.
    const preflight = isolatedUpdateCommand(staged, home, ["-e", "process.exit(0)"]);
    await run(preflight.command, preflight.args, options);
    await run("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], options);
    validateDependencyLock(before, JSON.parse(await fs.readFile(path.join(staged, "package-lock.json"), "utf8")), sdk, state.target);
    await run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], options);
    if (await installedSdkVersion(staged) !== sdk.version) throw new Error("Staged SDK version mismatch.");
    const treeSha256 = await dependencyTreeDigest(path.join(staged, "node_modules"));
    await verifyIsolatedUpdate(staged, home, run, options);
    const verified = await run("npm", ["audit", "--audit-level=moderate", "--ignore-scripts"], options);
    await fs.writeFile(path.join(directory, "verification.log"), verified.stdout || "Verification passed.\n", { mode: 0o600 });
    // SDK import and test commands ran only inside the isolated mount/PID/network namespace.
    const verifiedPackage = JSON.parse(await fs.readFile(pkgPath, "utf8"));
    if (verifiedPackage.dependencies?.["@openai/codex-sdk"] !== sdk.version || verifiedPackage.devDependencies?.["@openai/codex"] !== state.target) throw new Error("Package pins changed during verification.");
    validateDependencyLock(before, JSON.parse(await fs.readFile(path.join(staged, "package-lock.json"), "utf8")), sdk, state.target);
    for (const name of manifests) transaction.prepared[name] = digest(await fs.readFile(path.join(staged, name)));
    if (JSON.stringify(await approvedSdk(config, state.target)) !== JSON.stringify(sdk)) throw new Error("Approval changed during verification.");
    await verifyDependencySource(root, transaction, run);
    await fs.rm(path.join(directory, "npm-cache"), { recursive: true, force: true });
    if (treeSha256 !== await dependencyTreeDigest(path.join(staged, "node_modules"))) throw new Error("Dependency tree changed during verification.");
    await signControlRecord(controlDirectory, `dependencies-${state.id}`, { id: state.id, directory, treeSha256, prepared: transaction.prepared });
    return transaction;
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function verifyDependencySource(root, transaction, run = runUpdateProcess) {
  if (await cleanHead(root, run) !== transaction.head) throw new Error("Repository changed while preparing the update.");
  for (const name of manifests) {
    if (digest(await fs.readFile(path.join(root, name))) !== transaction.originals[name]) throw new Error("Dependencies changed before activation.");
  }
  if (await installedSdkVersion(root) !== transaction.previousVersion) throw new Error("Installed SDK changed before activation.");
}

export async function activateCodexDependencies(root, transaction) {
  if (!transaction.approval) throw new Error("Legacy dependency transaction requires fresh independent approval.");
  const approved = await approvedSdk({ codexUpdateTrustFile: transaction.approval.trustFile }, transaction.approval.target);
  if (JSON.stringify(approved) !== JSON.stringify(transaction.approval.sdk)) throw new Error("Approval changed before activation.");
  const { staged, backup } = transactionPaths(root, transaction);
  for (const name of manifests) {
    if (digest(await fs.readFile(path.join(staged, name))) !== transaction.prepared[name]) throw new Error("Prepared dependency manifest changed.");
  }
  const attestation = await readControlRecord(transaction.controlDirectory, `dependencies-${transaction.id}`);
  if (attestation.directory !== transaction.directory || JSON.stringify(attestation.prepared) !== JSON.stringify(transaction.prepared) || attestation.treeSha256 !== await dependencyTreeDigest(path.join(staged, "node_modules"))) throw new Error("Staged dependency tree changed after verification.");
  await fs.rename(path.join(root, "node_modules"), path.join(backup, "node_modules"));
  await fs.rename(path.join(staged, "node_modules"), path.join(root, "node_modules"));
  if (attestation.treeSha256 !== await dependencyTreeDigest(path.join(root, "node_modules"))) throw new Error("Activated dependency tree changed.");
  for (const name of manifests) await writePrivateFileAtomic(path.join(root, name), await fs.readFile(path.join(staged, name), "utf8"));
}

export async function restoreCodexDependencies(root, transaction) {
  const { directory, backup } = transactionPaths(root, transaction);
  if (await exists(path.join(backup, "node_modules"))) {
    if (await exists(path.join(root, "node_modules"))) {
      // Keep the failed tree for diagnosis; never overwrite a prior recovery.
  await fs.rename(path.join(root, "node_modules"), path.join(directory, "failed-node_modules"));
    }
    await fs.rename(path.join(backup, "node_modules"), path.join(root, "node_modules"));
  }
  for (const name of manifests) {
    const original = await fs.readFile(path.join(backup, name), "utf8");
    if (digest(original) !== transaction.originals[name]) throw new Error("Dependency backup integrity mismatch.");
    await writePrivateFileAtomic(path.join(root, name), original);
  }
  if (await installedSdkVersion(root) !== transaction.previousVersion) throw new Error("SDK rollback version mismatch.");
}

export async function finishCodexDependencies(root, transaction) {
  const { directory } = transactionPaths(root, transaction);
  // Only called once success or rollback has been persisted. Keep the small log.
  for (const name of ["project", "backup", "failed-node_modules", "home", "npm-cache"]) {
    await fs.rm(path.join(directory, name), { recursive: true, force: true });
  }
}
