import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { readCandidate, requirePackageApproval, validatePackageUpdate } from "./publish_package_update.mjs";

// This runs on a fresh read-only runner, never in the dependency test job.
// Candidate hashes are review evidence, not a source of approval.
export function reviewPackageUpdate(base, data, approval = {}) {
  const candidate = JSON.parse(data["package.json"]);
  validatePackageUpdate(base, candidate, JSON.parse(data["package-lock.json"]));
  const hashes = {
    packageSha256: createHash("sha256").update(data["package.json"]).digest("hex"),
    lockSha256: createHash("sha256").update(data["package-lock.json"]).digest("hex")
  };
  for (const key of Object.keys(hashes)) {
    if (approval[key] && !/^[a-f0-9]{64}$/.test(approval[key])) throw new Error(`Invalid configured approval: ${key}`);
  }
  let status = "approved";
  if (!approval.packageSha256 || !approval.lockSha256) status = "awaiting-approval";
  else if (Object.keys(hashes).some((key) => approval[key] !== hashes[key])) status = "awaiting-new-approval";
  if (status === "approved") requirePackageApproval(data, approval);
  return { status, approved: status === "approved", ...hashes,
    sdk: candidate.dependencies["@openai/codex-sdk"], cli: candidate.devDependencies["@openai/codex"] };
}

async function main() {
  const data = await readCandidate(process.argv[2]);
  const base = JSON.parse(await fs.readFile("package.json", "utf8"));
  const review = reviewPackageUpdate(base, data, {
    packageSha256: process.env.CODEX_APPROVED_PACKAGE_SHA256,
    lockSha256: process.env.CODEX_APPROVED_LOCK_SHA256
  });
  const summary = [
    "### Codex dependency candidate review", "",
    `Status: **${review.status}**`, "",
    `- SDK: \`${review.sdk}\``, `- CLI: \`${review.cli}\``,
    `- package.json SHA256: \`${review.packageSha256}\``,
    `- package-lock.json SHA256: \`${review.lockSha256}\``, "",
    review.approved ? "The exact files match independent approval; publication may proceed."
      : "Tests passed, but publication is waiting for independent approval. No update PR will be created.", "",
    "Download the package-update artifact and independently review the complete package/lock diff and provenance.",
    "Only after review, an authorized maintainer can set repository variables CODEX_APPROVED_PACKAGE_SHA256 and CODEX_APPROVED_LOCK_SHA256 to the reviewed exact file hashes, then re-run this workflow.",
    "Do not automatically copy candidate hashes into approval variables. A green test run is not approval.",
    "If a later candidate differs, it requires a new review. The publisher rechecks approval before any GitHub writes.", ""
  ].join("\n");
  if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
  if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, `approved=${review.approved}\n`);
  console.log(summary);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
