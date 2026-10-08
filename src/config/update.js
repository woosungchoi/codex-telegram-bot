import path from "node:path";
import { parseTelegramIdCsv } from "./parsers.js";

export function readCodexUpdateConfig(env, paths, access) {
  const wrapperRealPath = JSON.parse(env.CODEX_ENV_JSON || "null")?.CODEX_REAL_PATH || env.CODEX_REAL_PATH?.trim() || "";
  const wrapped = path.basename(env.CODEX_PATH?.trim() || "") === "codex-yolo";
  const admins = env.CODEX_UPDATE_ADMIN_USER_IDS?.trim()
    ? parseTelegramIdCsv(env.CODEX_UPDATE_ADMIN_USER_IDS, "CODEX_UPDATE_ADMIN_USER_IDS")
    : env.CODEX_ACCOUNT_ADMIN_USER_IDS?.trim()
      ? parseTelegramIdCsv(env.CODEX_ACCOUNT_ADMIN_USER_IDS, "CODEX_ACCOUNT_ADMIN_USER_IDS")
      : access.allowedUserIds.size === 1 ? [...access.allowedUserIds] : [];
  for (const id of admins) {
    if (!access.allowedUserIds.has(id)) throw new Error("CODEX_UPDATE_ADMIN_USER_IDS must be allowed users.");
  }
  return {
    codexUpdateTrustFile: env.CODEX_UPDATE_TRUST_FILE?.trim() || "",
    codexUpdateBin: env.CODEX_UPDATE_BIN?.trim() || (wrapped ? wrapperRealPath : "") || env.CODEX_PATH?.trim() || "codex",
    codexUpdateWrapperRealPath: wrapperRealPath,
    codexUpdateHome: path.resolve(env.CODEX_UPDATE_HOME?.trim() || path.join(paths.homeDir, ".codex")),
    codexUpdateDir: path.join(path.dirname(env.STATE_FILE?.trim() || path.join(paths.stateRoot, "threads.json")), "codex-update"),
    codexUpdateAdminUserIds: new Set(admins),
    codexUpdateBotService: env.CODEX_UPDATE_BOT_SERVICE?.trim() || "codex-telegram-bot.service",
    codexUpdateWorkerService: env.CODEX_UPDATE_WORKER_SERVICE?.trim() || "codex-telegram-worker.service",
    codexUpdateAppServerService: env.CODEX_UPDATE_APP_SERVER_SERVICE?.trim() || "codex-app-server.service"
  };
}
