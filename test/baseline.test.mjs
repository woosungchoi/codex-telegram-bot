import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

async function readJson(path) {
  return JSON.parse(await fs.readFile(new URL(`../${path}`, import.meta.url), "utf8"));
}

async function exists(path) {
  try {
    await fs.access(new URL(`../${path}`, import.meta.url));
    return true;
  } catch {
    return false;
  }
}

test("public package metadata and assets stay intact", async () => {
  const pkg = await readJson("package.json");
  assert.equal(pkg.name, "codex-telegram-bot");
  assert.equal(pkg.version, "1.0.6");
  assert.equal(pkg.license, "MIT");
  assert.equal(pkg.private, undefined);
  assert.equal(pkg.repository?.url, "git+https://github.com/woosungchoi/codex-telegram-bot.git");
  assert.equal(pkg.dependencies["@openai/codex-sdk"], "0.136.0");
  assert.ok(pkg.files.includes("assets"));
  assert.ok(pkg.files.includes("LICENSE"));
  assert.ok(pkg.files.includes("SECURITY.md"));
  assert.equal(await exists("assets/readme-hero.png"), true);
  assert.equal(await exists("assets/screenshots/main-control.jpg"), true);
  assert.equal(await exists("LICENSE"), true);
  assert.equal(await exists("SECURITY.md"), true);
  assert.equal(await exists("CONTRIBUTING.md"), true);
});

test("public CI keeps baseline verification commands", async () => {
  const workflow = await fs.readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(workflow, /npm ci/);
  assert.match(workflow, /npm run check/);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /npm run build --if-present/);
});
