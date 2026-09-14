import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const executeShell = promisify(exec);
const root = fileURLToPath(new URL("../", import.meta.url));

test("incremental type checking accepts untyped internals but rejects invalid workspace capabilities", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "workspace-types-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const config = path.join(directory, "tsconfig.json");
  const source = path.join(directory, "boundary.js");
  await fs.writeFile(
    config,
    JSON.stringify({
      extends: path.join(root, "tsconfig.json"),
      compilerOptions: { typeRoots: [path.join(root, "node_modules/@types")] },
      include: [source],
    }),
  );
  const compilerPackage = JSON.parse(
    await fs.readFile(
      path.join(root, "node_modules/typescript/package.json"),
      "utf8",
    ),
  );
  const version = await executeShell("npm run typecheck -- --version", {
    cwd: root,
  });
  assert.ok(
    version.stdout.trimEnd().endsWith(`Version ${compilerPackage.version}`),
    version.stdout,
  );
  const compiler = path.join(
    root,
    "node_modules/typescript",
    compilerPackage.bin.tsc,
  );
  const check = () =>
    execute(
      process.execPath,
      [compiler, "--project", config, "--pretty", "false"],
      { cwd: root },
    );
  const fixture = (method) =>
    [
      "// @ts-check",
      `/** @param {import(${JSON.stringify(path.join(root, "src/workspace/contracts.js"))}).WorkspaceBackend} backend */`,
      `export function read(backend) { return backend.${method}(); }`,
      "export function identity(value) { return value; }",
    ].join("\n");
  await fs.writeFile(source, fixture("listSessions"));
  await check();
  await fs.writeFile(source, fixture("missingCapability"));
  await assert.rejects(check(), (error) => {
    assert.match(error.stdout, /TS2339/);
    assert.match(error.stdout, /missingCapability/);
    return true;
  });
});
