import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { validateRegistryLockUpdate } from "./codex_registry_policy.mjs";

const FILES = ["package-lock.json", "package.json"];
const VERSION = /^\d+\.\d+\.\d+$/;
function withoutVersions(pkg) {
  const value = globalThis.structuredClone(pkg);
  delete value.dependencies?.["@openai/codex-sdk"];
  delete value.devDependencies?.["@openai/codex"];
  return value;
}
export function validatePackageUpdate(base, candidate, lock) {
  if (!isDeepStrictEqual(withoutVersions(base), withoutVersions(candidate))) throw new Error("Only Codex package versions may change.");
  for (const [section, name] of [["dependencies", "@openai/codex-sdk"], ["devDependencies", "@openai/codex"]]) {
    if (!VERSION.test(candidate[section]?.[name])) throw new Error("Stable pinned Codex version required.");
    if (lock.packages?.[""]?.[section]?.[name] !== candidate[section][name]) throw new Error("Root lock mismatch.");
    if (lock.packages?.[`node_modules/${name}`]?.version !== candidate[section][name]) throw new Error("Package lock mismatch.");
  }
  if (lock.lockfileVersion !== 3 || lock.name !== base.name || lock.version !== base.version) throw new Error("Unexpected lock metadata.");
  const root = lock.packages?.[""];
  if (!root || !isDeepStrictEqual(root.dependencies, candidate.dependencies) || !isDeepStrictEqual(root.devDependencies, candidate.devDependencies)) throw new Error("Unexpected root dependencies.");
  for (const [name, item] of Object.entries(lock.packages)) {
    if (!name) continue;
    if (!name.startsWith("node_modules/") || name.includes("..") || item.link || !/^https:\/\/registry\.npmjs\.org\//.test(item.resolved || "") || !/^sha512-[A-Za-z0-9+/]+=*$/.test(item.integrity || "")) throw new Error("Unsafe lock entry.");
  }
}
export async function readCandidate(directory) {
  if (!isDeepStrictEqual((await fs.readdir(directory)).sort(), FILES)) throw new Error("Artifact must contain only two package JSON files.");
  const data = {};
  for (const name of FILES) {
    const file = await fs.open(path.join(directory, name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > (name === "package.json" ? 128 * 1024 : 4 * 1024 * 1024)) throw new Error("Invalid package data size/type.");
      data[name] = await file.readFile("utf8");
      JSON.parse(data[name]);
    } finally { await file.close(); }
  }
  return data;
}
export function requirePackageApproval(data, approval) {
  for (const [name, key] of [["package.json", "packageSha256"], ["package-lock.json", "lockSha256"]]) {
    if (!/^[a-f0-9]{64}$/.test(approval?.[key] || "")
      || createHash("sha256").update(data[name]).digest("hex") !== approval[key]) {
      throw new Error("Independent exact package/lock approval required before publication.");
    }
  }
}
async function main() {
  const data = await readCandidate(process.argv[2]);
  requirePackageApproval(data, { packageSha256: process.env.CODEX_APPROVED_PACKAGE_SHA256, lockSha256: process.env.CODEX_APPROVED_LOCK_SHA256 });
  const base = JSON.parse(await fs.readFile("package.json", "utf8"));
  validatePackageUpdate(base, JSON.parse(data["package.json"]), JSON.parse(data["package-lock.json"]));
  if (process.argv.includes("--automatic")) await validateRegistryLockUpdate(
    JSON.parse(await fs.readFile("package-lock.json", "utf8")), JSON.parse(data["package-lock.json"]));
  const repo = process.env.GITHUB_REPOSITORY;
  const sha = process.env.BASE_SHA;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || "") || !/^[a-f0-9]{40}$/.test(sha || "")) throw new Error("Invalid trusted publication context.");
  const token = process.env.GH_TOKEN;
  if (!token) throw new Error("Publish token missing.");
  async function api(endpoint, method = "GET", payload) {
    const r = await fetch(`https://api.github.com/repos/${repo}/${endpoint}`, { method,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
      body: payload === undefined ? undefined : JSON.stringify(payload) });
    if (!r.ok) throw new Error(`GitHub publication failed: ${r.status}`);
    return r.status === 204 ? null : r.json();
  }
  const digest = createHash("sha256").update(sha).update(data["package.json"]).update(data["package-lock.json"]).digest("hex");
  const branch = `automation/codex-${digest.slice(0, 20)}`;
  const existing = await api(`pulls?state=open&head=${encodeURIComponent(repo.split("/")[0] + ":" + branch)}`);
  // Keep one Codex update in flight across version/base changes. The merger
  // refreshes it against main; the next daily run can propose a newer version.
  const pending = await api("pulls?state=open&base=main&per_page=100");
  if (!existing.length && pending.some((pr) => pr.head?.repo?.full_name === repo
    && /^automation\/codex-[a-f0-9]{20}$/.test(pr.head?.ref || "")
    && pr.title === "Update Codex packages" && pr.user?.login === repo.split("/")[0])) {
    console.log("Existing Codex update is awaiting checks or review; no duplicate PR created.");
    return;
  }
  const baseCommit = await api(`git/commits/${sha}`);
  const tree = [];
  for (const name of FILES) {
    const blob = await api("git/blobs", "POST", { content: data[name], encoding: "utf-8" });
    tree.push({ path: name, mode: "100644", type: "blob", sha: blob.sha });
  }
  const updated = await api("git/trees", "POST", { base_tree: baseCommit.tree.sha, tree });
  const commit = await api("git/commits", "POST", { message: "Update Codex packages", tree: updated.sha, parents: [sha], author: baseCommit.author, committer: baseCommit.committer });
  // Content-bound branch: repeat runs do not open duplicate PRs. No force push.
  const refs = await api(`git/matching-refs/heads/${branch}`);
  const existingRef = refs.find((ref) => ref.ref === `refs/heads/${branch}`);
  if (existingRef && existingRef.object.sha !== commit.sha) throw new Error("Existing update branch differs from the approved commit.");
  if (existing.some((pr) => pr.head.sha !== commit.sha)) throw new Error("Existing update PR differs from the approved commit.");
  if (existing.length) return;
  if (!existingRef) await api("git/refs", "POST", { ref: `refs/heads/${branch}`, sha: commit.sha });
  await api("pulls", "POST", { head: branch, base: "main", title: "Update Codex packages",
    body: "Updates only the pinned Codex SDK/CLI packages. Installation and tests ran in a separate read-only job without publication credentials. The CI-based dependency policy and all nine required exact-head checks still apply before automatic merge." });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
