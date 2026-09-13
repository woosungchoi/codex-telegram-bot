import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { architectureProblems } from "../scripts/check-architecture.mjs";

test("architecture guard rejects runtime dependencies, sibling controller coupling and cycles", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "architecture-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "src/workspace"), { recursive: true });
  await fs.writeFile(
    path.join(root, "src/runtime.js"),
    "export const runtime = {};",
  );
  await fs.writeFile(
    path.join(root, "src/workspace/a_controller.js"),
    'import "../runtime.js"; export * from "./b_controller.js";',
  );
  await fs.writeFile(
    path.join(root, "src/workspace/b_controller.js"),
    'import "./a_controller.js";',
  );
  const result = await architectureProblems(root);
  assert.ok(
    result.errors.some((error) => error.includes("runtime composition")),
  );
  assert.ok(
    result.errors.some((error) => error.includes("sibling controller")),
  );
  assert.ok(result.errors.some((error) => error.includes("Import cycle")));
  await fs.writeFile(
    path.join(root, "src/workspace/a_controller.js"),
    "export const a = {};",
  );
  await fs.writeFile(
    path.join(root, "src/workspace/b_controller.js"),
    "export const b = {};",
  );
  assert.deepEqual((await architectureProblems(root)).errors, []);
});
