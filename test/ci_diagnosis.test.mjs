import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  classifyFailure,
  generateDiagnosis,
  redactSecrets,
} from "../scripts/ci_diagnosis.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = path.join(root, "test", "fixtures", "ci-diagnosis");

async function readFixture(name) {
  return fs.readFile(path.join(fixtures, name), "utf8");
}

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "ci-diagnosis-"));
}

test("classifies common CI failures with evidence and commands", async () => {
  const cases = [
    ["jq-error.log", "workflow-script-failure", "actionlint"],
    ["npm-lock-error.log", "npm-ci-failure", "npm ci"],
    ["prettier-error.log", "format-failure", "npm run format:check"],
    ["network-timeout.log", "registry-network-transient", "gh run rerun --failed"],
    ["test-assertion.log", "test-failure", "npm test"],
    ["permission-error.log", "permission-token-failure", "permissions"],
  ];

  for (const [fixture, type, commandFragment] of cases) {
    const classifications = classifyFailure(await readFixture(fixture));
    const match = classifications.find((item) => item.type === type);
    assert.ok(match, `${fixture} should classify as ${type}`);
    assert.ok(match.evidence.length > 0, `${type} should include evidence`);
    assert.ok(
      match.recommendedCommands.some((command) => command.includes(commandFragment)),
      `${type} should recommend ${commandFragment}`,
    );
  }
});

test("redacts secret-like values before markdown output", () => {
  const input = [
    "token=ghp_abcdefghijklmnopqrstuvwxyz1234567890",
    "pat=github_pat_11ABCDEFG_abcdefghijklmnopqrstuvwxyz0123456789",
    "openai=sk-abcdefghijklmnopqrstuvwxyz01234567890123456789",
    "jwt=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signaturevalue",
  ].join("\n");

  const output = redactSecrets(input);
  assert.doesNotMatch(output, /ghp_[A-Za-z0-9_]+/);
  assert.doesNotMatch(output, /github_pat_[A-Za-z0-9_]+/);
  assert.doesNotMatch(output, /sk-[A-Za-z0-9_-]+/);
  assert.doesNotMatch(output, /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
  assert.match(output, /\[REDACTED\]/);
});

test("generates authless diagnosis markdown from run, jobs, and failed log", async () => {
  const run = JSON.parse(await readFixture("run.json"));
  const jobs = JSON.parse(await readFixture("jobs.json"));
  const log = await readFixture("jq-error.log");

  const diagnosis = generateDiagnosis({ run, jobs, log, runUrl: run.url, prNumber: 17 });

  assert.equal(diagnosis.run.id, 26935231746);
  assert.equal(diagnosis.failedJobs.length, 1);
  assert.equal(diagnosis.failedJobs[0].name, "Merge Verified Dependency PRs");
  assert.equal(diagnosis.failedJobs[0].failedSteps[0].name, "Merge eligible dependency PRs");
  assert.ok(diagnosis.classifications.some((item) => item.type === "workflow-script-failure"));
  assert.match(diagnosis.markdown, /## CI 기본 진단/);
  assert.match(diagnosis.markdown, /Merge Verified Dependency PRs/);
  assert.match(diagnosis.markdown, /workflow-script-failure/);
  assert.match(diagnosis.markdown, /gh run rerun --failed 26935231746/);
  assert.match(diagnosis.markdown, /PR: #17/);
});

test("generated markdown keeps log excerpts inside the fenced block", () => {
  const diagnosis = generateDiagnosis({
    run: { databaseId: 1, workflowName: "CI", conclusion: "failure", status: "completed" },
    jobs: { jobs: [] },
    log: "attacker tries to close fence\n```\n# injected heading",
  });

  assert.doesNotMatch(diagnosis.markdown, /\n```\n# injected heading/);
  assert.match(diagnosis.markdown, /`\u200b``/);
});

test("CLI redacts arbitrary files for AI prompts and artifacts", async () => {
  const tmp = await makeTempDir();
  const input = path.join(tmp, "raw.txt");
  const output = path.join(tmp, "redacted.txt");
  await fs.writeFile(input, "secret ghp_abcdefghijklmnopqrstuvwxyz1234567890 and sk-abcdefghijklmnopqrstuvwxyz1234567890");

  await execFileAsync(process.execPath, [
    path.join(root, "scripts", "ci_diagnosis.mjs"),
    "--redact-file",
    input,
    "--redacted-out",
    output,
  ]);

  const redacted = await fs.readFile(output, "utf8");
  assert.doesNotMatch(redacted, /ghp_[A-Za-z0-9_]+/);
  assert.doesNotMatch(redacted, /sk-[A-Za-z0-9_-]+/);
  assert.match(redacted, /\[REDACTED\]/);
});

test("CLI writes markdown and json diagnosis artifacts", async () => {
  const tmp = await makeTempDir();
  const summaryOut = path.join(tmp, "summary.md");
  const jsonOut = path.join(tmp, "diagnosis.json");
  const logDir = path.join(tmp, "logs");
  await fs.mkdir(logDir);
  await fs.copyFile(path.join(fixtures, "jq-error.log"), path.join(logDir, "failed-tail.log"));

  await execFileAsync(
    process.execPath,
    [
      path.join(root, "scripts", "ci_diagnosis.mjs"),
      "--run-json",
      path.join(fixtures, "run.json"),
      "--jobs-json",
      path.join(fixtures, "jobs.json"),
      "--log-dir",
      logDir,
      "--summary-out",
      summaryOut,
      "--json-out",
      jsonOut,
      "--run-url",
      "https://github.com/woosungchoi/codex-telegram-bot/actions/runs/26935231746",
      "--pr-number",
      "17",
    ],
    { cwd: root },
  );

  const summary = await fs.readFile(summaryOut, "utf8");
  const json = JSON.parse(await fs.readFile(jsonOut, "utf8"));

  assert.match(summary, /## CI 기본 진단/);
  assert.match(summary, /workflow-script-failure/);
  assert.equal(json.run.id, 26935231746);
  assert.equal(json.failedJobs.length, 1);
});
