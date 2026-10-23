import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { reviewPackageUpdate } from "../scripts/review_package_update.mjs";
import { requirePackageApproval } from "../scripts/publish_package_update.mjs";

const data = Object.fromEntries(await Promise.all(["package.json", "package-lock.json"].map(async (name) =>
  [name, await fs.readFile(new URL(`../${name}`, import.meta.url), "utf8")])));
const base = JSON.parse(data["package.json"]);
const approval = {
  packageSha256: createHash("sha256").update(data["package.json"]).digest("hex"),
  lockSha256: createHash("sha256").update(data["package-lock.json"]).digest("hex")
};

test("missing or partial independent approval waits without permitting publication", () => {
  for (const supplied of [{}, { packageSha256: approval.packageSha256 }, { lockSha256: approval.lockSha256 }]) {
    const result = reviewPackageUpdate(base, data, supplied);
    assert.equal(result.status, "awaiting-approval");
    assert.equal(result.approved, false);
    assert.throws(() => requirePackageApproval(data, supplied), /Independent/);
  }
});

test("exact independent hashes permit publication; any changed bytes need renewed approval", () => {
  assert.equal(reviewPackageUpdate(base, data, approval).approved, true);
  for (const name of Object.keys(data)) {
    const changed = { ...data, [name]: `${data[name]} ` };
    const result = reviewPackageUpdate(base, changed, approval);
    assert.equal(result.status, "awaiting-new-approval");
    assert.equal(result.approved, false);
    assert.throws(() => requirePackageApproval(changed, approval), /Independent/);
  }
});

test("malformed configured hashes fail instead of silently waiting", () => {
  for (const key of Object.keys(approval)) for (const value of ["bad", "A".repeat(64), `${approval[key]}\n`]) {
    assert.throws(() => reviewPackageUpdate(base, data, { ...approval, [key]: value }), /Invalid configured approval/);
  }
});

test("invalid candidates fail even when approval is absent", () => {
  const candidate = globalThis.structuredClone(base);
  candidate.scripts.postinstall = "untrusted executable";
  assert.throws(() => reviewPackageUpdate(base, { ...data, "package.json": JSON.stringify(candidate) }), /Only Codex/);
  const lock = JSON.parse(data["package-lock.json"]);
  lock.packages["node_modules/injected"] = { resolved: "https://evil.invalid/package", integrity: "sha512-AAAA" };
  assert.throws(() => reviewPackageUpdate(base, { ...data, "package-lock.json": JSON.stringify(lock) }), /Unsafe lock/);
});

test("read-only CLI reports pending and approved outputs without a publication token", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "package-review-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const artifact = path.join(root, "artifact");
  await fs.mkdir(artifact);
  await fs.writeFile(path.join(root, "package.json"), data["package.json"]);
  for (const [name, content] of Object.entries(data)) await fs.writeFile(path.join(artifact, name), content);
  const helper = fileURLToPath(new URL("../scripts/review_package_update.mjs", import.meta.url));
  for (const approved of [false, true]) {
    const output = path.join(root, `output-${approved}`), summary = path.join(root, `summary-${approved}`);
    const result = spawnSync(process.execPath, [helper, artifact], { cwd: root, encoding: "utf8", env: {
      GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary,
      ...(approved ? { CODEX_APPROVED_PACKAGE_SHA256: approval.packageSha256, CODEX_APPROVED_LOCK_SHA256: approval.lockSha256 } : {})
    } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await fs.readFile(output, "utf8"), `approved=${approved}\n`);
    const report = await fs.readFile(summary, "utf8");
    assert.ok(report.includes(approval.packageSha256));
    assert.ok(report.includes(approval.lockSha256));
    assert.match(report, /Do not automatically copy candidate hashes/);
    if (!approved) assert.match(report, /No update PR will be created/);
  }
  await fs.writeFile(path.join(artifact, "extra.sh"), "untrusted executable");
  const rejectedOutput = path.join(root, "rejected-output");
  const result = spawnSync(process.execPath, [helper, artifact], { cwd: root, encoding: "utf8", env: { GITHUB_OUTPUT: rejectedOutput } });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /only two/);
  await assert.rejects(fs.access(rejectedOutput), { code: "ENOENT" });
});

test("workflow gates the write-capable job on separate read-only approval review", async () => {
  const workflow = await fs.readFile(new URL("../.github/workflows/codex-sdk-update.yml", import.meta.url), "utf8");
  const review = workflow.split("  review:")[1].split("  publish:")[0];
  const publish = workflow.split("  publish:")[1];
  assert.match(review, /contents: read/);
  assert.match(review, /ref: \$\{\{ github.sha \}\}/);
  assert.match(review, /review_package_update\.mjs/);
  assert.match(review, /vars.CODEX_APPROVED_PACKAGE_SHA256/);
  assert.match(review, /vars.CODEX_APPROVED_LOCK_SHA256/);
  assert.doesNotMatch(review, /contents: write|pull-requests: write|secrets\.|npm (ci|install|test)|GH_TOKEN:/);
  assert.match(publish, /needs: \[update, review\]/);
  assert.match(publish, /needs.review.outputs.approved == 'true'/);
  assert.match(publish, /publish_package_update\.mjs/);
  assert.match(publish, /vars.CODEX_APPROVED_PACKAGE_SHA256/);
  assert.match(publish, /vars.CODEX_APPROVED_LOCK_SHA256/);
});
