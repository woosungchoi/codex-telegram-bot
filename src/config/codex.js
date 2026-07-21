import path from "node:path";
import {
  CONFIG_VALID,
  assertEnum,
  normalizeMultilineEnv,
  parseCompactStrength,
  parseCsv,
  parseNonnegativeInteger,
  parseOptionalBoolean,
  parseOptionalJson,
  parsePercentInteger
} from "./parsers.js";

export function readCodexConfig(env, paths) {
  const codexApprovalPolicy = env.CODEX_APPROVAL_POLICY?.trim() || "never";
  const codexSandboxMode = env.CODEX_SANDBOX_MODE?.trim() || "workspace-write";
  const codexReasoningEffort = env.CODEX_REASONING_EFFORT?.trim() || "medium";
  const codexWebSearch = env.CODEX_WEB_SEARCH?.trim() || "disabled";
  const codexTransport = env.CODEX_TRANSPORT?.trim() || "sdk";
  const codexWorkerMode = env.CODEX_WORKER_MODE?.trim() || "sidecar";
  assertEnum(codexApprovalPolicy, CONFIG_VALID.approval, "CODEX_APPROVAL_POLICY");
  assertEnum(codexSandboxMode, CONFIG_VALID.sandbox, "CODEX_SANDBOX_MODE");
  assertEnum(codexReasoningEffort, CONFIG_VALID.reasoning, "CODEX_REASONING_EFFORT");
  assertEnum(codexWebSearch, CONFIG_VALID.webSearch, "CODEX_WEB_SEARCH");
  assertEnum(codexTransport, CONFIG_VALID.codexTransport, "CODEX_TRANSPORT");
  assertEnum(codexWorkerMode, CONFIG_VALID.codexWorkerMode, "CODEX_WORKER_MODE");

  const workerStateDir = env.CODEX_WORKER_STATE_DIR?.trim() || path.join(paths.stateRoot, "worker");
  return {
    codexWorkdir: env.CODEX_WORKDIR?.trim() || paths.homeDir,
    codexPath: env.CODEX_PATH?.trim() || "codex",
    codexTransport,
    codexAppServerDirectTimeoutMs: parseNonnegativeInteger(
      env.CODEX_APP_SERVER_DIRECT_TIMEOUT_MS,
      5000,
      "CODEX_APP_SERVER_DIRECT_TIMEOUT_MS"
    ),
    codexWorkerMode,
    codexWorkerStateDir: workerStateDir,
    codexWorkerSocket: env.CODEX_WORKER_SOCKET?.trim() || path.join(workerStateDir, "worker.sock"),
    codexWorkerConnectTimeoutMs: parseNonnegativeInteger(
      env.CODEX_WORKER_CONNECT_TIMEOUT_MS,
      5000,
      "CODEX_WORKER_CONNECT_TIMEOUT_MS"
    ),
    codexWorkerEventPollMs: parseNonnegativeInteger(
      env.CODEX_WORKER_EVENT_POLL_MS,
      1000,
      "CODEX_WORKER_EVENT_POLL_MS"
    ),
    codexModel: env.CODEX_MODEL?.trim() || "",
    codexApprovalPolicy,
    codexSandboxMode,
    codexReasoningEffort,
    codexWebSearch,
    codexPersonaPrompt: normalizeMultilineEnv(env.CODEX_PERSONA_PROMPT),
    codexNetworkAccess: parseOptionalBoolean(env.CODEX_NETWORK_ACCESS),
    codexWebSearchEnabled: parseOptionalBoolean(env.CODEX_WEB_SEARCH_ENABLED),
    codexSkipGitRepoCheck: parseOptionalBoolean(env.CODEX_SKIP_GIT_REPO_CHECK) ?? false,
    codexAdditionalDirectories: parseCsv(env.CODEX_ADDITIONAL_DIRECTORIES),
    codexBaseUrl: env.CODEX_BASE_URL?.trim() || "",
    codexApiKey: env.CODEX_API_KEY?.trim() || "",
    codexConfig: parseOptionalJson(env, "CODEX_CONFIG_JSON"),
    codexEnv: parseOptionalJson(env, "CODEX_ENV_JSON"),
    codexModelContextWindow: parseNonnegativeInteger(
      env.CODEX_MODEL_CONTEXT_WINDOW,
      0,
      "CODEX_MODEL_CONTEXT_WINDOW"
    ),
    codexAutoCompactTokenLimit: parseNonnegativeInteger(
      env.CODEX_AUTO_COMPACT_TOKEN_LIMIT,
      0,
      "CODEX_AUTO_COMPACT_TOKEN_LIMIT"
    ),
    codexToolOutputTokenLimit: parseNonnegativeInteger(
      env.CODEX_TOOL_OUTPUT_TOKEN_LIMIT,
      0,
      "CODEX_TOOL_OUTPUT_TOKEN_LIMIT"
    ),
    codexCompactStrength: parseCompactStrength(env.CODEX_COMPACT_STRENGTH),
    codexCompactPromptFile: env.CODEX_COMPACT_PROMPT_FILE?.trim() || "",
    codexContextGuardEnabled: parseOptionalBoolean(env.CODEX_CONTEXT_GUARD_ENABLED) ?? true,
    codexContextCompactThresholdPercent: parsePercentInteger(
      env.CODEX_CONTEXT_COMPACT_THRESHOLD_PERCENT,
      75,
      "CODEX_CONTEXT_COMPACT_THRESHOLD_PERCENT"
    ),
    codexContextMinRemainingTokens: parseNonnegativeInteger(
      env.CODEX_CONTEXT_MIN_REMAINING_TOKENS,
      40000,
      "CODEX_CONTEXT_MIN_REMAINING_TOKENS"
    ),
    codexModelsCacheFile: env.CODEX_MODELS_CACHE_FILE?.trim()
      || path.join(paths.codexHome, "models_cache.json")
  };
}
