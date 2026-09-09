import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const wrapperPath = fileURLToPath(new URL("../bin/codex-yolo", import.meta.url));
const localCliPath = fileURLToPath(new URL("../node_modules/.bin/codex", import.meta.url));

function cliEnvironment(overrides = {}) {
  const env = { ...process.env };
  delete env.CODEX_REAL_PATH;
  return { ...env, ...overrides };
}

async function createCliFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bin-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const wrapper = path.join(root, "bin", "codex-yolo");
  await fs.mkdir(path.dirname(wrapper), { recursive: true });
  await fs.copyFile(wrapperPath, wrapper);
  await fs.chmod(wrapper, 0o700);
  const selectedCli = path.join(root, "custom cli", "codex");
  await fs.mkdir(path.dirname(selectedCli), { recursive: true });
  await fs.writeFile(selectedCli, "#!/bin/sh\nprintf '%s\\n' 'selected-cli' \"$@\"\n", { mode: 0o700 });
  return { root, wrapper, selectedCli };
}

async function readJson(path) {
  return JSON.parse(await fs.readFile(new URL(`../${path}`, import.meta.url), "utf8"));
}

test("package exposes bot and worker bins and preserves yolo helper", async () => {
  const pkg = await readJson("package.json");
  assert.equal(pkg.bin?.["codex-telegram-bot"], "./bin/codex-telegram-bot");
  assert.equal(pkg.bin?.["codex-telegram-worker"], "./bin/codex-telegram-worker");
  assert.equal(pkg.bin?.["codex-yolo"], undefined);

  const botBin = await fs.stat(new URL("../bin/codex-telegram-bot", import.meta.url));
  const workerBin = await fs.stat(new URL("../bin/codex-telegram-worker", import.meta.url));
  const yoloBin = await fs.stat(new URL("../bin/codex-yolo", import.meta.url));
  assert.notEqual(botBin.mode & 0o111, 0);
  assert.notEqual(workerBin.mode & 0o111, 0);
  assert.notEqual(yoloBin.mode & 0o111, 0);
});

test("codex-yolo defaults to the installed package-local CLI independently of inherited overrides", async () => {
  const script = await fs.readFile(wrapperPath, "utf8");
  assert.equal(script.includes("node_modules/.bin/codex"), true);
  const options = { timeout: 5000, env: cliEnvironment() };
  const { stdout } = await execFileAsync(wrapperPath, ["--version"], options);
  const localCli = await execFileAsync(localCliPath, ["--version"], options);
  assert.match(localCli.stdout.trim(), /^codex-cli \S+/);
  assert.equal(stdout.trim(), localCli.stdout.trim());
});

test("codex-yolo reports the version of the currently configured CLI", async () => {
  const options = { timeout: 5000, env: { ...process.env } };
  const selectedCli = options.env.CODEX_REAL_PATH || localCliPath;
  const actual = await execFileAsync(wrapperPath, ["--version"], options);
  const expected = await execFileAsync(selectedCli, ["--version"], options);
  assert.match(expected.stdout.trim(), /^codex-cli \S+/);
  assert.equal(actual.stdout.trim(), expected.stdout.trim());
});

test("codex-yolo honors an override path with spaces and forwards exec arguments", async (t) => {
  const { root, wrapper, selectedCli } = await createCliFixture(t);
  const fakeLocalCli = path.join(root, "node_modules", ".bin", "codex");
  await fs.mkdir(path.dirname(fakeLocalCli), { recursive: true });
  await fs.writeFile(fakeLocalCli, "#!/bin/sh\nexit 42\n", { mode: 0o700 });
  const options = { timeout: 5000, env: cliEnvironment({ CODEX_REAL_PATH: selectedCli }) };
  const version = await execFileAsync(wrapper, ["--version"], options);
  assert.equal(version.stdout, "selected-cli\n--version\n");
  const execution = await execFileAsync(wrapper, ["exec", "--model", "test-model", "two words"], options);
  assert.deepEqual(execution.stdout.trimEnd().split("\n"), [
    "selected-cli", "exec", "--dangerously-bypass-approvals-and-sandbox",
    "--model", "test-model", "two words"
  ]);
});

test("codex-yolo falls back to PATH without a local CLI for unset or empty overrides", async (t) => {
  const { wrapper, selectedCli } = await createCliFixture(t);
  for (const override of [{}, { CODEX_REAL_PATH: "" }]) {
    const env = cliEnvironment({
      PATH: `${path.dirname(selectedCli)}${path.delimiter}${process.env.PATH || ""}`,
      ...override
    });
    const { stdout } = await execFileAsync(wrapper, ["--version"], { timeout: 5000, env });
    assert.equal(stdout, "selected-cli\n--version\n");
  }
});

test("codex-yolo does not hide an invalid explicit CLI path with a fallback", async (t) => {
  const { root, wrapper, selectedCli } = await createCliFixture(t);
  const env = cliEnvironment({
    CODEX_REAL_PATH: path.join(root, "missing-cli"),
    PATH: `${path.dirname(selectedCli)}${path.delimiter}${process.env.PATH || ""}`
  });
  await assert.rejects(
    execFileAsync(wrapper, ["--version"], { timeout: 5000, env }),
    (error) => error.code === 127 && error.stdout === ""
  );
});

test("package files keep public assets, docs, and runtime source", async () => {
  const pkg = await readJson("package.json");
  for (const entry of ["assets", "bin", "docs", "scripts", "src", "systemd", "LICENSE", "SECURITY.md", "CONTRIBUTING.md"]) {
    assert.ok(pkg.files.includes(entry), `${entry} missing from package files`);
  }
});
