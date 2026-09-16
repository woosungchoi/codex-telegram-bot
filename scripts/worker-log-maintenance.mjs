import "dotenv/config";
import { readConfig } from "../src/config.js";
import { createWorkerClient } from "../src/worker/client.js";

const args = process.argv.slice(2);
if (
  args.some((arg) => !["--apply", "--dry-run"].includes(arg)) ||
  (args.includes("--apply") && args.includes("--dry-run"))
) {
  throw new Error(
    "Usage: node scripts/worker-log-maintenance.mjs [--dry-run | --apply]",
  );
}
const result = await createWorkerClient(readConfig()).archiveLogs({
  apply: args.includes("--apply"),
});
console.log(JSON.stringify(result, null, 2));
