import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { validatePackageUpdate } from "./publish_package_update.mjs";
import { validateRegistryLockUpdate, registryMetadata } from "./codex_registry_policy.mjs";

export const REQUIRED_CHECKS = [
  // Keep exact names aligned with ci.yml; the regression test rejects drift.
  "Check Node 22.23.4", "Check Node 24.22.1", "Check Node 26.12.1",
  "Security audit", "Integration coverage", "Upload workflow data fixture", "Artifact transport compatibility"
];
const SHA = /^[a-f0-9]{40}$/;
const CODEX = /^automation\/codex-[a-f0-9]{20}$/;
export function updateKind(pr, repo) {
  if (pr.state !== "open" || pr.draft || pr.base?.ref !== "main" || pr.head?.repo?.full_name !== repo || pr.base?.repo?.full_name !== repo) return null;
  if (pr.user?.login === "dependabot[bot]" && pr.user?.type === "Bot" && pr.user.id === 49699333) {
    if (pr.head.ref.startsWith("dependabot/npm_and_yarn/")) return "npm";
    if (pr.head.ref.startsWith("dependabot/github_actions/")) return "actions";
  }
  if (pr.user?.login === repo.split("/")[0] && pr.user.type === "User" && CODEX.test(pr.head.ref) && pr.title === "Update Codex packages") return "codex";
  return null;
}
function version(value) {
  const match = /^[~^]?(\d+)\.(\d+)\.(\d+)$/.exec(value || "");
  if (!match) throw new Error("Only stable semantic versions are eligible.");
  return match.slice(1).map(Number);
}
function compare(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}
export function validateVersions(base, candidate, kind) {
  const before = globalThis.structuredClone(base);
  const after = globalThis.structuredClone(candidate);
  let changed = false;
  for (const section of ["dependencies", "devDependencies", "overrides"]) {
    for (const [name, old] of Object.entries(base[section] || {})) {
      const next = candidate[section]?.[name];
      if (old === next) continue;
      const a = version(old), b = version(next);
      const codex = name === "@openai/codex" || name === "@openai/codex-sdk";
      if ((kind === "codex") !== codex || compare(b, a) < 0 || a[0] !== b[0]) throw new Error("Manual version review required.");
      if (!codex && a[0] === 0 && a[1] !== b[1]) throw new Error("Pre-1.0 minor update requires review.");
      before[section][name] = after[section][name] = "VERSION";
      changed = true;
    }
  }
  if (!changed || !isDeepStrictEqual(before, after)) throw new Error("Only existing dependency versions may change.");
}
export function validateActions(before, after) {
  // Only replace existing action refs/comments; no new steps, inputs or permissions.
  const pattern = /^(\s*(?:- )?uses: ([\w.-]+\/[\w./-]+)@)([a-zA-Z0-9.-]+)(?: # v(\d+)(?:\.[0-9]+){0,2})?\s*$/gm;
  const refs = [];
  const stripped = before.replace(pattern, (_, prefix, name, ref, major) => {
    refs.push({ name, ref, major: major || /^v(\d+)(?:\.|$)/.exec(ref)?.[1] });
    return prefix + "REF";
  });
  let i = 0, changed = false;
  const next = after.replace(pattern, (_, prefix, name, ref, major) => {
    const old = refs[i++];
    const nextMajor = major || /^v(\d+)(?:\.|$)/.exec(ref)?.[1];
    if (!old || old.name !== name || !old.major || old.major !== nextMajor || (SHA.test(old.ref) && !SHA.test(ref))) throw new Error("Action upgrade requires manual review.");
    if (old.ref !== ref) changed = true;
    return prefix + "REF";
  });
  if (!changed || i !== refs.length || stripped !== next) throw new Error("Only action version references may change.");
}
export function checksPass(checks, sha) {
  if (!SHA.test(sha || "")) return false;
  // GitHub's latest check runs, from the GitHub Actions app, on the exact head.
  const trusted = checks.filter((c) => c.app?.id === 15368 && c.app?.slug === "github-actions" && c.head_sha === sha);
  return REQUIRED_CHECKS.every((name) => trusted.some((c) => c.name === name && c.status === "completed" && c.conclusion === "success"))
    && trusted.every((c) => !REQUIRED_CHECKS.includes(c.name) || c.conclusion === "success")
    && checks.every((c) => c.head_sha === sha && c.status === "completed" && ["success", "skipped", "neutral"].includes(c.conclusion));
}
export async function reconcile({ repo, api, log = console.log, dryRun = false, getMetadata = registryMetadata }) {
  const pulls = await api("pulls?state=open&base=main&per_page=100");
  const newestCodex = Math.max(0, ...pulls.filter((pr) => updateKind(pr, repo) === "codex").map((pr) => pr.number));
  // Newest Codex candidate first; never merge an older candidate as a downgrade.
  for (const listed of [...pulls].sort((a, b) => b.number - a.number)) {
    const pr = await api(`pulls/${listed.number}`);
    const kind = updateKind(pr, repo);
    if (!kind || (kind === "codex" && pr.number !== newestCodex)) continue;
    try {
      const files = await api(`pulls/${pr.number}/files?per_page=100`);
      if (!files.length || files.length !== pr.changed_files || files.some((f) => f.status !== "modified")) throw new Error("Unexpected or incomplete file list.");
      const content = async (file, ref) => {
        if (!SHA.test(ref)) throw new Error("Invalid revision.");
        const result = await api(`contents/${file}?ref=${ref}`);
        if (result.type !== "file" || result.encoding !== "base64" || result.size > 4 * 1024 * 1024) throw new Error("Unexpected file data.");
        return Buffer.from(result.content, "base64").toString("utf8");
      };
      const main = await api("git/ref/heads/main");
      const baseSha = main.object.sha;
      const comparison = await api(`compare/${baseSha}...${pr.head.sha}`);
      const policyBase = comparison.merge_base_commit.sha;
      if (kind === "actions") {
        for (const file of files) {
          if (!/^\.github\/workflows\/[\w-]+\.yml$/.test(file.filename)) throw new Error("Non-workflow file.");
          validateActions(await content(file.filename, policyBase), await content(file.filename, pr.head.sha));
        }
      } else {
        if (files.some((f) => !["package.json", "package-lock.json"].includes(f.filename))) throw new Error("Non-package file.");
        const base = JSON.parse(await content("package.json", policyBase));
        const candidate = JSON.parse(await content("package.json", pr.head.sha));
        validateVersions(base, candidate, kind);
        const lock = JSON.parse(await content("package-lock.json", pr.head.sha));
        validatePackageUpdate(kind === "codex" ? base : candidate, candidate, lock);
        if (kind === "codex") await validateRegistryLockUpdate(JSON.parse(await content("package-lock.json", policyBase)), lock, getMetadata);
      }
      if (pr.mergeable_state === "behind") {
        log(`#${pr.number}: update branch, then wait for new CI`);
        if (!dryRun) await api(`pulls/${pr.number}/update-branch`, "PUT", { expected_head_sha: pr.head.sha });
        continue;
      }
      if (pr.mergeable_state !== "clean" || !pr.mergeable) throw new Error("Awaiting mergeability/checks/review.");
      const response = await api(`commits/${pr.head.sha}/check-runs?filter=latest&per_page=100`);
      if (response.total_count !== response.check_runs.length || !checksPass(response.check_runs, pr.head.sha)) throw new Error("All exact-head checks must pass.");
      const status = await api(`commits/${pr.head.sha}/status`);
      if (status.total_count && status.state !== "success") throw new Error("Commit status has not passed.");
      const latest = await api(`pulls/${pr.number}`);
      const currentMain = await api("git/ref/heads/main");
      if (updateKind(latest, repo) !== kind || latest.head.ref !== pr.head.ref || latest.head.sha !== pr.head.sha || currentMain.object.sha !== baseSha || latest.mergeable_state !== "clean") throw new Error("Revision changed; retry next run.");
      log(`#${pr.number}: verified ${pr.head.sha}; squash merge`);
      if (!dryRun) {
        const result = await api(`pulls/${pr.number}/merge`, "PUT", { sha: pr.head.sha, merge_method: "squash" });
        if (!result.merged) throw new Error("Merge was not accepted.");
        // Serialize changes against main; the next CI completion/schedule advances the queue.
        return;
      }
    } catch (error) {
      log(`#${pr.number}: held — ${error.message}`);
    }
  }
}
async function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || "") || !token) throw new Error("Trusted repository and automation token required.");
  const api = async (endpoint, method = "GET", data) => {
    const result = await fetch(`https://api.github.com/repos/${repo}/${endpoint}`, {
      method, signal: globalThis.AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
      body: data === undefined ? undefined : JSON.stringify(data)
    });
    if (!result.ok) throw new Error(`GitHub API ${result.status}`);
    return result.status === 204 ? null : result.json();
  };
  await reconcile({ repo, api, dryRun: process.argv.includes("--dry-run") });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
