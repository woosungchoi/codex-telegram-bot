import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const defaultAppRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export function resolveConfigPaths(env, options = {}) {
  const appRoot = options.appRoot ?? defaultAppRoot;
  const cwd = options.cwd ?? process.cwd();
  const homeDir = env.HOME || cwd;
  const defaultCodexHome = path.join(homeDir, ".codex");
  const defaultCodexSessionsDir = path.join(defaultCodexHome, "sessions");
  const codexHome = env.CODEX_HOME?.trim()
    || path.dirname(env.CODEX_SESSIONS_DIR?.trim() || defaultCodexSessionsDir);
  const codexSessionsDir = env.CODEX_SESSIONS_DIR?.trim() || path.join(codexHome, "sessions");
  return {
    appRoot,
    codexHome,
    codexSessionsDir,
    homeDir,
    stateRoot: path.join(appRoot, "state")
  };
}
