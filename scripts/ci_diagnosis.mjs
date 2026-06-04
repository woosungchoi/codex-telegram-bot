import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SECRET_PATTERNS = [
  /ghp_[A-Za-z0-9_]{8,}/g,
  /github_pat_[A-Za-z0-9_]{8,}/g,
  /sk-[A-Za-z0-9_-]{8,}/g,
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  /([A-Za-z0-9+/]{40,}={0,2})/g,
];

const CLASSIFIERS = [
  {
    type: "workflow-script-failure",
    label: "GitHub Actions script/workflow 오류",
    confidence: "high",
    patterns: [/jq: error/i, /bad substitution/i, /syntax error near unexpected token/i, /\.github\/workflows/i],
    recommendedCommands: [
      "actionlint .github/workflows/*.yml",
      "실패한 shell/jq expression의 dot context와 quoting을 확인하세요.",
    ],
  },
  {
    type: "npm-ci-failure",
    label: "npm install/lockfile 오류",
    confidence: "high",
    patterns: [/npm ci/i, /ELOCKVERIFY/i, /package-lock\.json/i, /package\.json and package-lock\.json are in sync/i],
    recommendedCommands: ["npm ci", "package.json/package-lock.json 동기화 여부를 확인하세요."],
  },
  {
    type: "lint-failure",
    label: "ESLint 오류",
    confidence: "medium",
    patterns: [/eslint/i, /npm run lint/i, /max-warnings=0/i],
    recommendedCommands: ["npm run lint"],
  },
  {
    type: "syntax-check-failure",
    label: "Node syntax check 오류",
    confidence: "medium",
    patterns: [/node --check/i, /SyntaxError/i, /Unexpected token/i],
    recommendedCommands: ["npm run check", "node --check <file>"],
  },
  {
    type: "test-failure",
    label: "테스트 실패",
    confidence: "high",
    patterns: [/\bnot ok\b/i, /AssertionError/i, /node --test/i, /Expected values to be strictly/i],
    recommendedCommands: ["npm test", "필요하면 특정 테스트 파일만 node --test로 재실행하세요."],
  },
  {
    type: "format-failure",
    label: "Prettier/format 오류",
    confidence: "high",
    patterns: [/prettier/i, /Code style issues found/i, /npm run format:check/i],
    recommendedCommands: ["npm run format:check", "npx prettier --write package.json package-lock.json .github/workflows/*.yml"],
  },
  {
    type: "audit-failure",
    label: "npm audit 취약점 gate 실패",
    confidence: "medium",
    patterns: [/npm audit/i, /vulnerabilities/i, /audit-level/i],
    recommendedCommands: ["npm audit --audit-level=moderate", "취약 dependency 업데이트 PR을 확인하세요."],
  },
  {
    type: "registry-network-transient",
    label: "registry/network 일시 장애 가능성",
    confidence: "medium",
    patterns: [/ECONNRESET/i, /ETIMEDOUT/i, /EAI_AGAIN/i, /502 Bad Gateway/i, /npm ERR! network/i, /getaddrinfo/i],
    recommendedCommands: ["gh run rerun --failed <run-id>", "npm ping"],
  },
  {
    type: "permission-token-failure",
    label: "GitHub token/permissions 오류",
    confidence: "high",
    patterns: [/Resource not accessible by integration/i, /Bad credentials/i, /HTTP 403/i, /permission/i],
    recommendedCommands: ["workflow permissions 블록과 GITHUB_TOKEN 권한을 확인하세요."],
  },
  {
    type: "codex-optional-skip",
    label: "Codex optional 진단/리뷰 skip",
    confidence: "medium",
    patterns: [/CODEX_ACCESS_TOKEN/i, /Codex OAuth login failed/i, /Codex CLI package could not be installed/i],
    recommendedCommands: ["Codex AI 진단이 필요할 때만 CODEX_ACCESS_TOKEN secret을 갱신하세요."],
  },
];

export function redactSecrets(text = "") {
  return SECRET_PATTERNS.reduce((redacted, pattern) => redacted.replace(pattern, "[REDACTED]"), text);
}

function findEvidence(log, patterns) {
  const lines = redactSecrets(log).split(/\r?\n/);
  const evidence = [];
  for (const line of lines) {
    if (patterns.some((pattern) => pattern.test(line))) {
      evidence.push(line.trim().slice(0, 500));
    }
    if (evidence.length >= 5) {
      break;
    }
  }
  return evidence;
}

export function classifyFailure(log = "") {
  return CLASSIFIERS.map((classifier) => ({
    ...classifier,
    evidence: findEvidence(log, classifier.patterns),
  }))
    .filter((classifier) => classifier.evidence.length > 0)
    .map(({ patterns: _patterns, ...classifier }) => classifier);
}

function normalizeRun(run = {}, { runUrl } = {}) {
  return {
    id: run.databaseId ?? run.id ?? null,
    name: run.workflowName ?? run.name ?? "unknown",
    title: run.displayTitle ?? run.name ?? "unknown",
    event: run.event ?? "unknown",
    headBranch: run.headBranch ?? "unknown",
    headSha: run.headSha ?? "unknown",
    conclusion: run.conclusion ?? "unknown",
    status: run.status ?? "unknown",
    url: runUrl || run.url || run.html_url || "",
  };
}

function failedSteps(job = {}) {
  return (job.steps ?? [])
    .filter((step) => step.conclusion && !["success", "skipped", "neutral"].includes(String(step.conclusion).toLowerCase()))
    .map((step) => ({
      name: step.name ?? `step-${step.number ?? "unknown"}`,
      number: step.number ?? null,
      status: step.status ?? "unknown",
      conclusion: step.conclusion ?? "unknown",
    }));
}

function normalizeJobs(jobsJson = {}) {
  const jobs = Array.isArray(jobsJson) ? jobsJson : jobsJson.jobs ?? [];
  return jobs
    .filter((job) => job.conclusion && !["success", "skipped", "neutral"].includes(String(job.conclusion).toLowerCase()))
    .map((job) => ({
      name: job.name ?? "unknown",
      status: job.status ?? "unknown",
      conclusion: job.conclusion ?? "unknown",
      startedAt: job.startedAt ?? job.started_at ?? null,
      completedAt: job.completedAt ?? job.completed_at ?? null,
      failedSteps: failedSteps(job),
    }));
}

function formatList(items, fallback = "없음") {
  if (!items.length) {
    return `- ${fallback}`;
  }
  return items.map((item) => `- ${item}`).join("\n");
}

function escapeMarkdownFence(text) {
  return text.replaceAll("```", "`\u200b``");
}

function logExcerpt(log) {
  const redacted = redactSecrets(log).trim();
  if (!redacted) {
    return "로그 excerpt를 수집하지 못했습니다.";
  }
  const lines = redacted.split(/\r?\n/).slice(-80).join("\n");
  const excerpt = lines.length > 12000 ? lines.slice(-12000) : lines;
  return escapeMarkdownFence(excerpt);
}

export function generateDiagnosis({ run = {}, jobs = {}, log = "", runUrl = "", prNumber = "" } = {}) {
  const normalizedRun = normalizeRun(run, { runUrl });
  const failedJobs = normalizeJobs(jobs);
  const classifications = classifyFailure(log);
  const rerunCommand = normalizedRun.id ? `gh run rerun --failed ${normalizedRun.id}` : "gh run rerun --failed <run-id>";
  const prLine = prNumber ? `- PR: #${prNumber}` : "- PR: 연결된 PR을 찾지 못했습니다.";

  const failedJobsMarkdown = failedJobs.length
    ? failedJobs
        .map((job) => {
          const steps = job.failedSteps.length
            ? job.failedSteps.map((step) => `  - 실패 step: ${step.name} (${step.conclusion})`).join("\n")
            : "  - 실패 step: GitHub API 응답에서 특정 step을 찾지 못했습니다.";
          return `- ${job.name} (${job.conclusion})\n${steps}`;
        })
        .join("\n")
    : "- 실패 job metadata를 찾지 못했습니다. 로그 excerpt를 확인하세요.";

  const classificationMarkdown = classifications.length
    ? classifications
        .map((item) => {
          const evidence = item.evidence.map((line) => `  - \`${line.replaceAll("`", "'")}\``).join("\n");
          return `- \`${item.type}\` — ${item.label} (${item.confidence})\n${evidence}`;
        })
        .join("\n")
    : "- `unknown` — 알려진 패턴과 일치하지 않습니다. 실패 job/step과 로그 excerpt를 직접 확인하세요.";

  const recommendedCommands = new Set([rerunCommand]);
  for (const item of classifications) {
    for (const command of item.recommendedCommands) {
      recommendedCommands.add(command.replace("<run-id>", String(normalizedRun.id ?? "<run-id>")));
    }
  }

  const markdown = `## CI 기본 진단\n\n### Run\n\n- Workflow: ${normalizedRun.name}\n- Title: ${normalizedRun.title}\n- Conclusion: ${normalizedRun.conclusion}\n- Status: ${normalizedRun.status}\n- Event: ${normalizedRun.event}\n- Head branch: ${normalizedRun.headBranch}\n- Head SHA: ${normalizedRun.headSha}\n- Run: ${normalizedRun.url || "unknown"}\n${prLine}\n\n### 실패 Job / Step\n\n${failedJobsMarkdown}\n\n### 결론 후보\n\n${classificationMarkdown}\n\n### 추천 다음 행동\n\n${formatList([...recommendedCommands])}\n\n### 실패 로그 Tail\n\n\`\`\`text\n${logExcerpt(log)}\n\`\`\`\n`;

  return {
    run: normalizedRun,
    failedJobs,
    classifications,
    recommendations: [...recommendedCommands],
    markdown,
  };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) {
      throw new Error(`Unexpected argument: ${key}`);
    }
    args[key.slice(2)] = argv[index + 1];
    index += 1;
  }
  return args;
}

async function readJson(filePath, fallback = {}) {
  if (!filePath) {
    return fallback;
  }
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function readLog(logDir) {
  if (!logDir) {
    return "";
  }
  const candidates = ["failed-tail.log", "failed.log", "ci-run-tail.log", "ci-run.log"];
  for (const candidate of candidates) {
    try {
      return await fs.readFile(path.join(logDir, candidate), "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }
  return "";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args["redact-file"]) {
    const redacted = redactSecrets(await fs.readFile(args["redact-file"], "utf8"));
    if (args["redacted-out"]) {
      await fs.writeFile(args["redacted-out"], redacted);
    } else {
      process.stdout.write(redacted);
    }
    return;
  }

  const run = await readJson(args["run-json"]);
  const jobs = await readJson(args["jobs-json"]);
  const log = await readLog(args["log-dir"]);
  const diagnosis = generateDiagnosis({
    run,
    jobs,
    log,
    runUrl: args["run-url"],
    prNumber: args["pr-number"],
  });

  if (args["summary-out"]) {
    await fs.writeFile(args["summary-out"], diagnosis.markdown);
  }
  if (args["json-out"]) {
    await fs.writeFile(args["json-out"], `${JSON.stringify(diagnosis, null, 2)}\n`);
  }
  if (!args["summary-out"] && !args["json-out"]) {
    process.stdout.write(diagnosis.markdown);
  }
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
