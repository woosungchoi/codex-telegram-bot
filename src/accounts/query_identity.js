import fs from "node:fs/promises";
import path from "node:path";
import { accountConfig } from "./context.js";

// Metadata only: an external login/token replacement invalidates cached reads too.
export async function accountQueryIdentity(config, id = "default") {
  const home = accountConfig(config, id).codexHome;
  let revision = "missing";
  if (home) {
    try {
      const s = await fs.stat(path.join(home, "auth.json"), { bigint: true });
      revision = [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs]
        .map(String)
        .join(":");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return [id, home || "", revision];
}
