import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { updateKind, validateVersions, validateActions, checksPass, reconcile, REQUIRED_CHECKS } from "../scripts/merge_dependency_updates.mjs";
const repo = "owner/repo", head = "a".repeat(40), base = "b".repeat(40);
const pr = { number: 1, state: "open", draft: false, title: "Update Codex packages", changed_files: 2,
  user: { login: "owner", type: "User" }, head: { ref: `automation/codex-${"a".repeat(20)}`, sha: head, repo: { full_name: repo } },
  base: { ref: "main", repo: { full_name: repo } }, mergeable: true, mergeable_state: "clean" };
const pkg = { name: "test", version: "1.0.0", scripts: { test: "node --test" }, dependencies: { "@openai/codex-sdk": "0.160.1", dotenv: "^18.0.5" }, devDependencies: { "@openai/codex": "0.160.1" } };
const newer = () => { const p = globalThis.structuredClone(pkg); p.dependencies["@openai/codex-sdk"] = "0.162.1"; return p; };
const checks = () => REQUIRED_CHECKS.map((name) => ({ name, app: { id: 15368, slug: "github-actions" }, head_sha: head, status: "completed", conclusion: "success" }));
test("auto-merge requires every Node version actually run by CI", () => {
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const matrix = workflow.match(/^        node-version: \[([^\]\n]+)\]$/m);
  assert.ok(matrix, "Update this guard if the CI matrix format changes.");
  assert.match(workflow, /name: Check Node \$\{\{ matrix.node-version \}\}/);
  const versions = matrix[1].split(",").map(value => value.trim().replace(/^["']|["']$/g, ""));
  assert.deepEqual(REQUIRED_CHECKS.filter(name => name.startsWith("Check Node ")).sort(),
    versions.map(version => `Check Node ${version}`).sort(),
    "Keep auto-merge requirements aligned with the CI Node matrix.");
  for (const version of versions) {
    assert.equal(checksPass(checks().filter(check => check.name !== `Check Node ${version}`), head), false);
  }
});
test("only same-repository identified automation is eligible", () => {
  assert.equal(updateKind(pr, repo), "codex");
  for (const mutate of [p => p.draft = true, p => p.user.login = "outsider", p => p.head.repo.full_name = "fork/repo", p => p.base.ref = "release", p => p.state = "closed", p => p.title = "other"]) {
    const p = globalThis.structuredClone(pr); mutate(p); assert.equal(updateKind(p, repo), null);
  }
  const p = globalThis.structuredClone(pr); p.user = { login: "dependabot[bot]", type: "Bot", id: 49699333 }; p.head.ref = "dependabot/npm_and_yarn/group";
  assert.equal(updateKind(p, repo), "npm"); p.user.type = "User"; assert.equal(updateKind(p, repo), null);
});
test("Codex versions may increase; scripts, additions, majors and downgrades require review", () => {
  validateVersions(pkg, newer(), "codex");
  for (const mutate of [p => p.scripts.test = "evil", p => p.dependencies.new = "1.0.0", p => p.dependencies["@openai/codex-sdk"] = "1.0.0", p => p.dependencies["@openai/codex-sdk"] = "0.159.0", p => p.dependencies.dotenv = "^18.0.7"]) {
    const p = newer(); mutate(p); assert.throws(() => validateVersions(pkg, p, "codex"));
  }
  const p = globalThis.structuredClone(pkg); p.dependencies.dotenv = "^18.0.7"; validateVersions(pkg, p, "npm");
  p.dependencies.dotenv = "^19.0.0"; assert.throws(() => validateVersions(pkg, p, "npm"));
  assert.throws(() => validateVersions(pkg, newer(), "npm"));
});
test("action updates cannot add steps, change action identity, unpin or cross majors", () => {
  const a = `steps:\n  - uses: actions/upload-artifact@${head} # v7.0.1\n    with:\n      name: safe\n`;
  const b = a.replace(head, base).replace("7.0.1", "7.0.2");
  validateActions(a, b);
  for (const next of [b.replace("v7.0.2", "v8.0.0"), b.replace(base, "v7"), b.replace("actions/", "evil/"), b + "  - run: evil\n", b.replace("name: safe", "name: evil")]) assert.throws(() => validateActions(a, next));
});
test("all expected checks must succeed from GitHub Actions; skipped required or extra failure blocks", () => {
  assert.equal(checksPass(checks(), head), true);
  for (const mutate of [c => c.pop(), c => c[0].conclusion = "skipped", c => c[0].app.id = 1, c => c[0].head_sha = base, c => c[0].app.slug = "other", c => c[0].status = "in_progress", c => c.push({ status: "completed", conclusion: "failure" })]) {
    const c = checks(); mutate(c); assert.equal(checksPass(c, head), false);
  }
});
async function scenario(options = {}) {
  const p = { ...globalThis.structuredClone(pr), ...options.pr };
  const writes = [], logs = []; let mainReads = 0;
  const candidate = newer(); if (options.bad) candidate.scripts.test = "evil";
  const lock = { name: pkg.name, version: pkg.version, lockfileVersion: 3, packages: { "": candidate,
    "node_modules/@openai/codex-sdk": { version: "0.162.1", resolved: "https://registry.npmjs.org/sdk.tgz", integrity: "sha512-YQ==" },
    "node_modules/@openai/codex": { version: "0.160.1", resolved: "https://registry.npmjs.org/cli.tgz", integrity: "sha512-YQ==" } } };
  const baseLock = globalThis.structuredClone(lock);
  baseLock.packages[""] = pkg;
  baseLock.packages["node_modules/@openai/codex-sdk"].version = "0.160.1";
  if (options.lockAttack) options.lockAttack(lock);
  const api = async (url, method = "GET", body) => {
    if (method !== "GET") { writes.push({ url, method, body }); return { merged: true }; }
    if (url.startsWith("pulls?")) return [p];
    if (url === "pulls/1") return p;
    if (url.endsWith("/files?per_page=100")) return (options.files || ["package.json", "package-lock.json"]).map(filename => ({ filename, status: "modified" }));
    if (url === "git/ref/heads/main") return { object: { sha: options.race && mainReads++ ? "c".repeat(40) : base } };
    if (url.startsWith("compare/")) return { merge_base_commit: { sha: base } };
    if (url.startsWith("contents/")) {
      const data = url.includes("package-lock") ? (url.endsWith(base) ? baseLock : lock) : url.endsWith(base) ? pkg : candidate;
      return { type: "file", encoding: "base64", size: 1000, content: Buffer.from(JSON.stringify(data)).toString("base64") };
    }
    if (url.includes("/check-runs?")) { const c = options.checks || checks(); return { total_count: c.length, check_runs: c }; }
    if (url.endsWith("/status")) return { total_count: 0 };
    throw new Error(`Unexpected call ${url}`);
  };
  const getMetadata = async (name, version) => {
    if (options.registryError) throw new Error("Registry unavailable");
    return { name, version, dist: { tarball: "https://registry.npmjs.org/sdk.tgz", integrity: "sha512-YQ==" } };
  };
  await reconcile({ repo, api, getMetadata, log: v => logs.push(v), dryRun: options.dryRun });
  return { writes, logs };
}
test("valid exact-head candidate merges with SHA guard", async () => {
  const { writes } = await scenario(); assert.deepEqual(writes, [{ url: "pulls/1/merge", method: "PUT", body: { sha: head, merge_method: "squash" } }]);
});
test("behind Codex candidate refreshes the branch and waits for new CI", async () => {
  const { writes } = await scenario({ pr: { mergeable_state: "behind" } });
  assert.deepEqual(writes, [{ url: "pulls/1/update-branch", method: "PUT", body: { expected_head_sha: head } }]);
});
for (const [name, option] of Object.entries({ "dry run": { dryRun: true }, "head checks absent": { checks: [] }, "base race": { race: true }, "package script injection": { bad: true }, "extra file": { files: ["package.json", "evil.js"] }, "conflict": { pr: { mergeable_state: "dirty" } } })) {
  test(`${name} never mutates`, async () => assert.equal((await scenario(option)).writes.length, 0));
}

for (const [name, options] of Object.entries({
  "registry unavailable": { registryError: true },
  "registry integrity mismatch": { lockAttack: lock => { lock.packages["node_modules/@openai/codex-sdk"].integrity = "sha512-evil"; } },
  "CLI bin mutation without version increase": { lockAttack: lock => { lock.packages["node_modules/@openai/codex"].bin = { node: "evil.js" }; } },
  "lock structure injection": { lockAttack: lock => { lock.packages["node_modules/evil"] = { version: "1.0.0" }; } }
})) {
  test(`Codex refuses ${name} even with green CI`, async () => {
    assert.equal((await scenario(options)).writes.length, 0);
  });
}
