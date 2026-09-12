import path from "node:path";
import { parseTelegramIdCsv } from "./parsers.js";

export function readRuntimeConfig(env, paths) {
  const allowed = parseTelegramIdCsv(env.ALLOWED_USER_IDS, "ALLOWED_USER_IDS");
  const admins = env.CODEX_ACCOUNT_ADMIN_USER_IDS?.trim()
    ? parseTelegramIdCsv(env.CODEX_ACCOUNT_ADMIN_USER_IDS, "CODEX_ACCOUNT_ADMIN_USER_IDS")
    : allowed.length === 1 ? allowed : [];
  return {
    stateFile: env.STATE_FILE?.trim() || path.join(paths.stateRoot, "threads.json"),
    codexHome: paths.codexHome,
    codexSessionsDir: paths.codexSessionsDir,
    codexAccountsDir: env.CODEX_ACCOUNTS_DIR?.trim() || path.join(paths.stateRoot, "accounts"),
    codexAccountAdminUserIds: new Set(admins)
  };
}
