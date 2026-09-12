import path from "node:path";
import { accountHome, DEFAULT_ACCOUNT_ID } from "./store.js";

export function selectedAccountId(chat = {}) { return chat.accountId || DEFAULT_ACCOUNT_ID; }

export function accountThreadId(chat = {}, id = selectedAccountId(chat)) {
  if ((chat.threadAccountId || DEFAULT_ACCOUNT_ID) === id) return chat.threadId || "";
  return chat.accountThreads?.[id] || "";
}

export function rememberAccountThread(chat, threadId, id = DEFAULT_ACCOUNT_ID) {
  if (!threadId) return;
  chat.threadId = threadId;
  chat.threadAccountId = id;
  chat.accountThreads = { ...chat.accountThreads, [id]: threadId };
}

export function applyAccountEvent(chat, event) {
  if (event.type === "account.attempt.started") {
    chat.accountAttemptState = { accountId: event.accountId, threadId: event.threadId || "", triedAccountIds: event.triedAccountIds, hadActivity: event.hadActivity === true };
    return true;
  }
  if (event.type === "account.selected") {
    if (selectedAccountId(chat) === event.fromAccountId) chat.accountId = event.accountId;
    return true;
  }
  return false;
}

export function accountConfig(config, id = DEFAULT_ACCOUNT_ID) {
  if (id === DEFAULT_ACCOUNT_ID) return { ...config, codexAccountId: id };
  const home = accountHome(config, id);
  const env = { ...(config.codexEnv || process.env), CODEX_HOME: home };
  for (const key of ["CODEX_API_KEY", "OPENAI_API_KEY", "CODEX_ACCESS_TOKEN"]) delete env[key];
  return {
    ...config,
    codexAccountId: id,
    codexHome: home,
    codexSessionsDir: path.join(home, "sessions"),
    codexModelsCacheFile: path.join(home, "models_cache.json"),
    codexApiKey: "",
    codexBaseUrl: "",
    codexEnv: env,
    codexConfig: { ...(config.codexConfig || {}), cli_auth_credentials_store: "file", model_provider: "openai" },
    codexAuthFileStore: true
  };
}
