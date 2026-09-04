import { spawn } from "node:child_process";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 10_000;

function parseJson(value) {
  try {
    return JSON.parse(value.trim());
  } catch {
    return null;
  }
}

function outputText(result) {
  return `${result.stdout || ""}\n${result.stderr || ""}`;
}

function statusCode(payload) {
  const value = Number(payload?.statusCode ?? payload?.status);
  return Number.isFinite(value) ? value : null;
}

export function classifyAuditAttempt({
  code,
  stdout = "",
  stderr = "",
  packageTreeValid = null,
} = {}) {
  if (code === 0) {
    return { kind: "passed", reason: "audit-passed" };
  }

  const payload = parseJson(stdout);
  if (payload?.auditReportVersion || payload?.metadata?.vulnerabilities) {
    return {
      kind: "vulnerabilities",
      reason: "audit-report-found-vulnerabilities",
    };
  }

  const text = outputText({ stdout, stderr });
  if (/Invalid package tree/i.test(text)) {
    return packageTreeValid === true
      ? { kind: "transient", reason: "registry-rejected-valid-package-tree" }
      : { kind: "error", reason: "invalid-package-tree" };
  }

  const status = statusCode(payload);
  if (
    status === 429 ||
    (status !== null && status >= 500 && status <= 599) ||
    /\b(?:EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT)\b/i.test(text) ||
    /\bnetwork timeout\b/i.test(text) ||
    /\b(?:429|5\d\d)\s+(?:Too Many Requests|Bad Gateway|Service Unavailable|Gateway Timeout)\b/i.test(
      text,
    )
  ) {
    return {
      kind: "transient",
      reason: status ? `registry-http-${status}` : "registry-network-error",
    };
  }

  return { kind: "error", reason: "unexpected-audit-error" };
}

function runNpm(args) {
  const executable = process.platform === "win32" ? "npm.cmd" : "npm";
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function writeAttemptOutput(result) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

export async function runAuditGate({
  attempts = DEFAULT_ATTEMPTS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  auditLevel = "moderate",
  run = runNpm,
  wait = delay,
} = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await run([
      "audit",
      "--audit-level",
      auditLevel,
      "--json",
      "--fetch-retries",
      "0",
      "--fetch-timeout",
      "60000",
    ]);
    let packageTreeValid = null;
    if (/Invalid package tree/i.test(outputText(result))) {
      const tree = await run(["ls", "--all", "--json"]);
      packageTreeValid = tree.code === 0;
      if (!packageTreeValid) writeAttemptOutput(tree);
    }

    const classification = classifyAuditAttempt({
      ...result,
      packageTreeValid,
    });
    if (classification.kind === "passed") {
      writeAttemptOutput(result);
      return { ok: true, attempts: attempt, ...classification };
    }
    if (classification.kind !== "transient") {
      writeAttemptOutput(result);
      return { ok: false, attempts: attempt, ...classification };
    }

    console.warn(
      `npm audit infrastructure failure (${classification.reason}), attempt ${attempt}/${attempts}.`,
    );
    if (attempt < attempts) {
      await wait(retryDelayMs);
      continue;
    }

    console.warn(
      `::warning title=npm audit unavailable::Security audit could not reach a healthy registry endpoint after ${attempts} attempts (${classification.reason}).`,
    );
    return { ok: true, attempts: attempt, softFailed: true, ...classification };
  }

  return { ok: false, attempts: 0, kind: "error", reason: "audit-not-run" };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined)
      throw new Error(`Invalid argument: ${name || "<empty>"}`);
    options[name.slice(2)] = value;
  }
  return options;
}

function positiveInteger(value, fallback, name) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outcome = await runAuditGate({
    auditLevel: args["audit-level"] || "moderate",
    attempts: positiveInteger(args.attempts, DEFAULT_ATTEMPTS, "attempts"),
    retryDelayMs: positiveInteger(
      args["retry-delay-ms"],
      DEFAULT_RETRY_DELAY_MS,
      "retry-delay-ms",
    ),
  });
  if (!outcome.ok) process.exitCode = 1;
}

const isCli =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isCli) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
