import process from "node:process";
import { readCodexConfig } from "./config/codex.js";
import {
  readCleanupConfig,
  readCodexMaintenanceConfig,
  readUploadConfig
} from "./config/maintenance.js";
import {
  parseCodexAnswerFormat,
  parseLanguage,
  parseLocale,
  parseRequiredBoolean,
  parseTimeZone
} from "./config/parsers.js";
import { resolveConfigPaths } from "./config/paths.js";
import { readRecoveryConfig } from "./config/recovery.js";
import { readRuntimeConfig } from "./config/runtime.js";
import {
  readTelegramAccessConfig,
  readTelegramPreferencesConfig,
  readTelegramRuntimeConfig
} from "./config/telegram.js";

export {
  parseCodexAnswerFormat,
  parseLanguage,
  parseLocale,
  parseRequiredBoolean,
  parseTimeZone
};

export function readConfig(env = process.env, options = {}) {
  const paths = resolveConfigPaths(env, options);
  const telegramAccess = readTelegramAccessConfig(env);

  return {
    ...telegramAccess,
    ...readCodexConfig(env, paths),
    ...readTelegramPreferencesConfig(env),
    ...readRuntimeConfig(env, paths),
    ...readCodexMaintenanceConfig(env, paths),
    ...readRecoveryConfig(env, paths),
    ...readUploadConfig(env, paths),
    ...readTelegramRuntimeConfig(env),
    ...readCleanupConfig(env, paths, telegramAccess.allowedUserIds)
  };
}
