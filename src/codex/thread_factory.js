import { Codex } from "@openai/codex-sdk";
import { createAppServerThread } from "./app_server.js";
import { buildCodexCompactConfig } from "./compact.js";
import { createAccountThread } from "../accounts/thread.js";

export const CODEX_TRANSPORT_SDK = "sdk";
export const CODEX_TRANSPORT_APP_SERVER_DIRECT = "app-server-direct";

const RUNTIME_ONLY_OPTION_KEYS = [
  "streamEvents",
  "liveProgressEnabled",
  "liveProgressSource",
  "liveProgressDeletePolicy"
];

export function threadTransport(thread) {
  return thread?.transport === CODEX_TRANSPORT_APP_SERVER_DIRECT
    ? CODEX_TRANSPORT_APP_SERVER_DIRECT
    : CODEX_TRANSPORT_SDK;
}

export function buildCodexClientOptions(config, serviceTier = "") {
  const options = { codexPathOverride: config.codexPath };
  if (config.codexBaseUrl) options.baseUrl = config.codexBaseUrl;
  if (config.codexApiKey) options.apiKey = config.codexApiKey;
  const codexConfig = { ...(config.codexConfig ?? {}), ...buildCodexCompactConfig(config) };
  if (serviceTier) codexConfig.service_tier = serviceTier;
  if (Object.keys(codexConfig).length > 0) options.config = codexConfig;
  if (config.codexEnv) options.env = config.codexEnv;
  return options;
}

export function getCodexClient(codexClients, config, serviceTier = "") {
  const cacheKey = `${config.codexAccountId || "default"}:${config.codexHome || ""}:${serviceTier || "default"}`;
  if (!codexClients.has(cacheKey)) {
    codexClients.set(cacheKey, new Codex(buildCodexClientOptions(config, serviceTier)));
  }
  return codexClients.get(cacheKey);
}

export function buildSdkThreadOptions(effectiveOptions = {}) {
  const threadOptions = { ...effectiveOptions };
  for (const key of [...RUNTIME_ONLY_OPTION_KEYS, "serviceTier"]) delete threadOptions[key];
  return threadOptions;
}

export function buildAppServerDirectThreadOptions(config, effectiveOptions = {}) {
  const threadOptions = { ...effectiveOptions };
  for (const key of RUNTIME_ONLY_OPTION_KEYS) delete threadOptions[key];
  const codexConfig = { ...(config.codexConfig ?? {}), ...buildCodexCompactConfig(config) };
  if (Object.keys(codexConfig).length > 0) threadOptions.codexConfig = codexConfig;
  return threadOptions;
}

export function createCodexThread({
  transport = CODEX_TRANSPORT_SDK,
  threadId = "",
  effectiveOptions = {},
  config,
  codexClients = new Map(),
  accountId = "default",
  attemptState = {}
} = {}) {
  if (!config) throw new Error("config is required to create a Codex thread.");
  if (config.codexAccountsDir && !config.codexAccountId) {
    return createAccountThread({
      config, accountId, threadId, transport, attemptState,
      createThread: (scoped, id) => createCodexThread({ transport, threadId: id, effectiveOptions, config: scoped, codexClients })
    });
  }
  if (transport === CODEX_TRANSPORT_APP_SERVER_DIRECT) {
    return createAppServerThread({
      threadId,
      threadOptions: buildAppServerDirectThreadOptions(config, effectiveOptions),
      codexPath: config.codexPath,
      codexEnv: config.codexEnv,
      codexAuthFileStore: config.codexAuthFileStore,
      connectTimeoutMs: config.codexAppServerDirectTimeoutMs
    });
  }
  const threadOptions = buildSdkThreadOptions(effectiveOptions);
  return threadId
    ? getCodexClient(codexClients, config, effectiveOptions.serviceTier || "").resumeThread(threadId, threadOptions)
    : getCodexClient(codexClients, config, effectiveOptions.serviceTier || "").startThread(threadOptions);
}
