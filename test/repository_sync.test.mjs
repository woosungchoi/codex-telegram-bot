import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import {
  compareRepositories,
  reviewDifferences,
} from "../scripts/repository-sync.mjs";

const execute = promisify(execFile);
test("repository sync detects drift inside an approved file and unexpected files without displaying contents", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "repository-sync-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const git = async (...args) =>
    (await execute("git", args, { cwd: root })).stdout.trim();
  await git("init", "-q");
  await git("config", "user.name", "Test");
  await git("config", "user.email", "test@example.invalid");
  await fs.writeFile(
    path.join(root, "shared.js"),
    "export const shared = true;\n",
  );
  await git("add", ".");
  await git("-c", "commit.gpgsign=false", "commit", "-qm", "public");
  const publicRef = await git("rev-parse", "HEAD");
  await fs.writeFile(
    path.join(root, "extension.js"),
    "private data must not appear in reports\n",
  );
  await git("add", ".");
  await git("-c", "commit.gpgsign=false", "commit", "-qm", "private");
  const differences = await compareRepositories(root, "HEAD", publicRef);
  const manifest = {
    version: 1,
    differences: differences.map((entry) => ({
      ...entry,
      reason: "Deployment extension",
    })),
  };
  assert.deepEqual(reviewDifferences(differences, manifest), []);
  assert.equal(JSON.stringify(differences).includes("private data"), false);
  await fs.appendFile(path.join(root, "extension.js"), "new unreviewed code\n");
  await fs.writeFile(path.join(root, "forgotten-fix.js"), "common change\n");
  await git("add", ".");
  await git("-c", "commit.gpgsign=false", "commit", "-qm", "drift");
  assert.deepEqual(
    reviewDifferences(
      await compareRepositories(root, "HEAD", publicRef),
      manifest,
    ),
    [
      "Changed approved difference: extension.js",
      "Unreviewed difference: forgotten-fix.js",
    ],
  );
  assert.deepEqual(reviewDifferences([], manifest), [
    "Resolved difference still in manifest: extension.js",
  ]);
  const manifestPath = path.join(root, "manifest.json");
  await fs.writeFile(
    manifestPath,
    JSON.stringify({ ...manifest, metadataPath: "extension.js" }),
  );
  await assert.rejects(
    execute(
      process.execPath,
      [
        new URL("../scripts/repository-sync.mjs", import.meta.url).pathname,
        "HEAD",
        publicRef,
        manifestPath,
      ],
      { cwd: root },
    ),
    /metadataPath may exclude only the manifest file itself/,
  );
});
