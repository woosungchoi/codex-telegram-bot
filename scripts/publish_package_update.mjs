import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

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
async function main() {
  const data = await readCandidate(process.argv[2]);
  const base = JSON.parse(await fs.readFile("package.json", "utf8"));
  validatePackageUpdate(base, JSON.parse(data["package.json"]), JSON.parse(data["package-lock.json"]));
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
  if (existing.length) return;
  const baseCommit = await api(`git/commits/${sha}`);
  const tree = [];
  for (const name of FILES) {
    const blob = await api("git/blobs", "POST", { content: data[name], encoding: "utf-8" });
    tree.push({ path: name, mode: "100644", type: "blob", sha: blob.sha });
  }
  const updated = await api("git/trees", "POST", { base_tree: baseCommit.tree.sha, tree });
  const commit = await api("git/commits", "POST", { message: "Update Codex packages", tree: updated.sha, parents: [sha] });
  // Content-bound branch: repeat runs do not open duplicate PRs. No force push.
  const refs = await api(`git/matching-refs/heads/${branch}`);
  if (!refs.some((ref) => ref.ref === `refs/heads/${branch}`)) await api("git/refs", "POST", { ref: `refs/heads/${branch}`, sha: commit.sha });
  await api("pulls", "POST", { head: branch, base: "main", title: "Update Codex packages",
    body: "Updates only the pinned Codex SDK/CLI packages. Installation and tests ran in a separate read-only job without publication credentials. Required PR checks and review still apply." });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
