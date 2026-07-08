import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

async function readJson(path) {
  return JSON.parse(await fs.readFile(new URL(`../${path}`, import.meta.url), "utf8"));
}

async function exists(path) {
  try {
    await fs.access(new URL(`../${path}`, import.meta.url));
    return true;
  } catch {
    return false;
  }
}

async function lineCount(path) {
  const text = await fs.readFile(new URL(`../${path}`, import.meta.url), "utf8");
  return text.trimEnd().split("\n").length;
}

test("public package metadata and assets stay intact", async () => {
  const pkg = await readJson("package.json");
  assert.equal(pkg.name, "codex-telegram-bot");
  assert.equal(pkg.version, "1.2.3");
  assert.equal(pkg.license, "MIT");
  assert.equal(pkg.private, undefined);
  assert.equal(pkg.repository?.url, "git+https://github.com/woosungchoi/codex-telegram-bot.git");
  assert.match(pkg.dependencies["@openai/codex-sdk"], /^\d+\.\d+\.\d+$/);
  assert.match(pkg.devDependencies["@openai/codex"], /^\d+\.\d+\.\d+$/);
  assert.equal(pkg.devDependencies["@openai/codex"], pkg.dependencies["@openai/codex-sdk"]);
  assert.ok(pkg.files.includes("assets"));
  assert.ok(pkg.files.includes("LICENSE"));
  assert.ok(pkg.files.includes("SECURITY.md"));
  assert.equal(await exists("assets/readme-hero.png"), true);
  assert.equal(await exists("assets/screenshots/main-control.jpg"), true);
  assert.equal(await exists("LICENSE"), true);
  assert.equal(await exists("SECURITY.md"), true);
  assert.equal(await exists("CONTRIBUTING.md"), true);
});

test("public CI keeps baseline verification commands", async () => {
  const workflow = await fs.readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(workflow, /npm ci/);
  assert.match(workflow, /npm run verify/);
  assert.match(workflow, /raven-actions\/actionlint@v2/);
  assert.match(workflow, /npm pack --dry-run --json/);
  assert.match(workflow, /npm run build --if-present/);
  assert.match(workflow, /node-version: \[18, 20, 22\]/);
  assert.match(workflow, /node-version: \$\{\{ matrix\.node-version \}\}/);
});

test("optional Codex workflows degrade gracefully", async () => {
  const prReview = await fs.readFile(new URL("../.github/workflows/codex-pr-review.yml", import.meta.url), "utf8");
  const ciDiagnosis = await fs.readFile(new URL("../.github/workflows/codex-ci-diagnosis.yml", import.meta.url), "utf8");
  const dependencyUpdate = await fs.readFile(new URL("../.github/workflows/codex-sdk-update.yml", import.meta.url), "utf8");

  assert.match(ciDiagnosis, /Generate authless CI diagnosis/);
  assert.match(ciDiagnosis, /Collect CI metadata and failed logs/);
  assert.match(ciDiagnosis, /Publish CI diagnosis/);
  assert.match(ciDiagnosis, /Upload diagnosis artifacts/);
  assert.match(ciDiagnosis, /failed-tail\.redacted\.log/);
  assert.match(ciDiagnosis, /codex-ai-diagnosis\.redacted\.md/);
  assert.doesNotMatch(ciDiagnosis, /cp ci-logs\/failed-tail\.log ci-logs\/failed-tail\.redacted\.log/);
  assert.doesNotMatch(ciDiagnosis, /cp codex-ai-diagnosis\.md codex-ai-diagnosis\.redacted\.md/);
  assert.match(ciDiagnosis, /PR comment upsert failed; writing diagnosis to step summary instead/);
  assert.match(ciDiagnosis, /Authless CI diagnosis above is still available/);
  assert.ok(ciDiagnosis.indexOf("Generate authless CI diagnosis") < ciDiagnosis.indexOf("Check Codex OAuth token"));
  assert.ok(ciDiagnosis.indexOf("Append Codex AI diagnosis") > ciDiagnosis.indexOf("Login with Codex OAuth token"));

  for (const workflow of [prReview, ciDiagnosis]) {
    assert.match(workflow, /id: codex-cli/);
    assert.match(workflow, /available=false/);
    assert.match(workflow, /id: codex-login/);
    assert.match(workflow, /authenticated=false/);
    assert.match(workflow, /Codex OAuth login failed/);
  }

  assert.match(dependencyUpdate, /npm view @openai\/codex version 2>\/dev\/null \|\| true/);
  assert.match(dependencyUpdate, /sdk_available/);
  assert.match(dependencyUpdate, /cli_available/);
  assert.match(dependencyUpdate, /one or more Codex npm packages are currently unavailable/);
});

test("dependency auto-merge checks GitHub rollup conclusions safely", async () => {
  const workflow = await fs.readFile(new URL("../.github/workflows/dependency-pr-auto-merge.yml", import.meta.url), "utf8");
  assert.match(workflow, /\. as \$check/);
  assert.match(workflow, /index\(\$check\.conclusion \/\/ ""\)/);
  assert.doesNotMatch(workflow, /index\(\.conclusion \/\/ ""\)/);
});

test("bot entrypoint stays thin and runtime stays packaged", async () => {
  const bot = await fs.readFile(new URL("../src/bot.js", import.meta.url), "utf8");
  const pkg = await readJson("package.json");
  assert.equal(bot.trim(), 'import "./runtime.js";');
  assert.ok(await exists("src/runtime.js"));
  assert.ok(await lineCount("src/bot.js") <= 10);
  assert.ok(pkg.files.includes("src"));
});
