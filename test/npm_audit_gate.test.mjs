import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyAuditAttempt,
  runAuditGate,
} from "../scripts/npm_audit_gate.mjs";

const cleanReport = JSON.stringify({
  auditReportVersion: 2,
  metadata: {
    vulnerabilities: {
      info: 0,
      low: 0,
      moderate: 0,
      high: 0,
      critical: 0,
      total: 0,
    },
  },
});

test("classifies successful audits and vulnerability reports", () => {
  assert.equal(
    classifyAuditAttempt({ code: 0, stdout: cleanReport }).kind,
    "passed",
  );
  assert.equal(
    classifyAuditAttempt({
      code: 1,
      stdout: JSON.stringify({
        auditReportVersion: 2,
        metadata: { vulnerabilities: { moderate: 1, total: 1 } },
      }),
    }).kind,
    "vulnerabilities",
  );
});

test("classifies registry outages as transient", () => {
  const result = classifyAuditAttempt({
    code: 1,
    stdout: JSON.stringify({ statusCode: 503, message: "Service Unavailable" }),
    stderr: "npm error audit endpoint returned an error",
  });
  assert.deepEqual(result, { kind: "transient", reason: "registry-http-503" });

  const timeout = classifyAuditAttempt({
    code: 1,
    stdout: JSON.stringify({
      message:
        "network timeout at: https://registry.npmjs.org/-/npm/v1/security/advisories/bulk",
    }),
    stderr: "npm error audit endpoint returned an error",
  });
  assert.deepEqual(timeout, {
    kind: "transient",
    reason: "registry-network-error",
  });
});

test("only tolerates invalid-tree responses when npm validates the local tree", () => {
  const input = {
    code: 1,
    stderr: "message: Invalid package tree, run npm install",
  };
  assert.equal(
    classifyAuditAttempt({ ...input, packageTreeValid: true }).kind,
    "transient",
  );
  assert.equal(
    classifyAuditAttempt({ ...input, packageTreeValid: false }).kind,
    "error",
  );
});

test("retries transient failures and succeeds when the registry recovers", async () => {
  const results = [
    {
      code: 1,
      stdout: JSON.stringify({ statusCode: 503 }),
      stderr: "Service Unavailable",
    },
    { code: 0, stdout: cleanReport, stderr: "" },
  ];
  const waits = [];
  const outcome = await runAuditGate({
    attempts: 3,
    retryDelayMs: 1,
    run: async () => results.shift(),
    wait: async (milliseconds) => waits.push(milliseconds),
    warn: () => {},
    write: () => {},
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.attempts, 2);
  assert.equal(outcome.softFailed, undefined);
  assert.deepEqual(waits, [1]);
});

test("fails closed after bounded registry retries", async () => {
  let calls = 0;
  const warnings = [];
  const outcome = await runAuditGate({
    attempts: 2,
    retryDelayMs: 1,
    run: async () => {
      calls += 1;
      return {
        code: 1,
        stdout: JSON.stringify({ statusCode: 429 }),
        stderr: "Too Many Requests",
      };
    },
    wait: async () => {},
    warn: (message) => warnings.push(message),
    write: () => {},
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.softFailed, undefined);
  assert.equal(outcome.attempts, 2);
  assert.equal(calls, 2);
  assert.ok(warnings.some((message) => message.startsWith("::error ")));
});

test("does not retry or mask reported vulnerabilities", async () => {
  let calls = 0;
  const outcome = await runAuditGate({
    attempts: 3,
    run: async () => {
      calls += 1;
      return {
        code: 1,
        stdout: JSON.stringify({
          auditReportVersion: 2,
          metadata: { vulnerabilities: { high: 1, total: 1 } },
        }),
        stderr: "",
      };
    },
    wait: async () => {},
    warn: () => {},
    write: () => {},
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.kind, "vulnerabilities");
  assert.equal(calls, 1);
});

for (const stdout of [
  "",
  "not json",
  "{}",
  JSON.stringify({ auditReportVersion: 2 }),
]) {
  test(`zero exit status with incomplete audit report cannot pass: ${stdout}`, () => {
    assert.equal(classifyAuditAttempt({ code: 0, stdout }).kind, "error");
  });
}
for (const response of [
  { code: 1, stdout: JSON.stringify({ statusCode: 503 }) },
  { code: 1, stderr: "ETIMEDOUT" },
  { code: 1, stderr: "Invalid package tree" },
])
  test(`unavailable audit never grants success: ${JSON.stringify(response)}`, async () => {
    const result = await runAuditGate({
      attempts: 2,
      retryDelayMs: 0,
      run: async (args) => (args[0] === "ls" ? { code: 0 } : response),
      wait: async () => {},
      warn: () => {},
      write: () => {},
    });
    assert.equal(result.ok, false);
    assert.equal(result.attempts, 2);
  });
