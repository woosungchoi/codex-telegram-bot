import path from "node:path";
import { pathToFileURL } from "node:url";

// Keep updater bootstrap independent of node_modules: a process may restart
// between moving the old dependency tree and selecting the new one.
export async function loadUpdateDotenv(appRoot, id) {
  if (!/^[a-f0-9-]{36}$/.test(id || "")) throw new Error("Update run ID required.");
  const load = (root) => import(pathToFileURL(path.join(root, "node_modules/dotenv/lib/main.js")).href);
  try { return (await load(appRoot)).default; }
  catch (error) {
    if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
    return (await load(path.join(appRoot, ".codex-update-deps", `run-${id}`, "backup"))).default;
  }
}
