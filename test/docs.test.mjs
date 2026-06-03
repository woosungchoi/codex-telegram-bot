import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

async function read(path) {
  return fs.readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("release and rollback runbooks cover required gates and smoke checks", async () => {
  const release = await read("docs/release-checklist.md");
  for (const text of [
    "npm ci",
    "npm run check",
    "npm run lint",
    "npm run format:check",
    "npm test",
    "npm audit --audit-level=moderate",
    "npm pack --dry-run --json",
    "/health",
    "/whoami",
    "/settings",
    "/cleanup_uploads"
  ]) {
    assert.match(release, new RegExp(escapeRegExp(text)));
  }
  assert.match(release, /npm run verify/);

  const rollback = await read("docs/rollback.md");
  for (const text of ["previous release tag", ".env", "state/", "systemctl --user restart", "journalctl", "npm ci --omit=dev"]) {
    assert.match(rollback, new RegExp(escapeRegExp(text)));
  }
});

test("README files link release and rollback docs", async () => {
  assert.match(await read("README.md"), /docs\/release-checklist\.md/);
  assert.match(await read("README.md"), /docs\/rollback\.md/);
  assert.match(await read("README.ko.md"), /docs\/release-checklist\.md/);
  assert.match(await read("README.ko.md"), /docs\/rollback\.md/);
});

test("README files document local verification", async () => {
  assert.match(await read("README.md"), /npm run verify/);
  assert.match(await read("README.ko.md"), /npm run verify/);
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
