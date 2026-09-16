import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAccountStore } from "../../src/accounts/store.js";

export async function accountFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-accounts-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = { codexHome: path.join(root, "host"), codexAccountsDir: path.join(root, "accounts"), codexSessionsDir: path.join(root, "host", "sessions") };
  await fs.mkdir(config.codexHome, { recursive: true });
  await fs.writeFile(path.join(config.codexHome, "config.toml"), 'model = "test-model"\n');
  await fs.writeFile(path.join(config.codexHome, "auth.json"), "HOST_TOKEN_SENTINEL", { mode: 0o600 });
  return { config, store: createAccountStore(config), root };
}
