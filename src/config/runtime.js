import path from "node:path";

export function readRuntimeConfig(env, paths) {
  return {
    stateFile: env.STATE_FILE?.trim() || path.join(paths.stateRoot, "threads.json"),
    codexHome: paths.codexHome,
    codexSessionsDir: paths.codexSessionsDir
  };
}
