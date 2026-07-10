import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  appendPrivateFile,
  ensurePrivateDirectory,
  hardenPrivateTree,
  writePrivateFile,
  writePrivateFileAtomic
} from "../src/fs/private.js";

function mode(stat) {
  return stat.mode & 0o777;
}

test("private filesystem helpers enforce owner-only permissions", { concurrency: false }, async (t) => {
  const previousUmask = process.umask(0o002);
  let root;

  try {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-private-fs-"));
    await t.test("creates and corrects private directories", async () => {
      const fresh = path.join(root, "fresh", "nested");
      await ensurePrivateDirectory(fresh);
      assert.equal(mode(await fs.stat(fresh)), 0o700);

      const existing = path.join(root, "existing");
      await fs.mkdir(existing, { mode: 0o775 });
      await fs.chmod(existing, 0o775);
      await ensurePrivateDirectory(existing);
      assert.equal(mode(await fs.stat(existing)), 0o700);
    });

    await t.test("writes and appends with private file modes", async () => {
      const fresh = path.join(root, "fresh-write.txt");
      await writePrivateFile(fresh, "first\n", "utf8");
      assert.equal(mode(await fs.stat(fresh)), 0o600);

      const existingWrite = path.join(root, "existing-write.txt");
      await fs.writeFile(existingWrite, "old\n", { mode: 0o664 });
      await fs.chmod(existingWrite, 0o664);
      await writePrivateFile(existingWrite, "new\n", "utf8");
      assert.equal(mode(await fs.stat(existingWrite)), 0o600);

      const existingAppend = path.join(root, "existing-append.txt");
      await fs.writeFile(existingAppend, "old\n", { mode: 0o664 });
      await fs.chmod(existingAppend, 0o664);
      await appendPrivateFile(existingAppend, "new\n", "utf8");
      assert.equal(mode(await fs.stat(existingAppend)), 0o600);
      assert.equal(await fs.readFile(existingAppend, "utf8"), "old\nnew\n");
    });

    await t.test("atomically overwrites with no temporary file left behind", async () => {
      const file = path.join(root, "atomic.json");
      await fs.writeFile(file, "old\n", { mode: 0o664 });
      await fs.chmod(file, 0o664);
      await writePrivateFileAtomic(file, "new\n");
      assert.equal(await fs.readFile(file, "utf8"), "new\n");
      assert.equal(mode(await fs.stat(file)), 0o600);
      assert.deepEqual((await fs.readdir(root)).filter((name) => name.includes("atomic.json.") && name.endsWith(".tmp")), []);
    });

    await t.test("failed atomic writes remove only their own temporary file", async () => {
      const target = path.join(root, "rename-target");
      const unrelated = path.join(root, "unrelated.tmp");
      await fs.mkdir(target);
      await fs.writeFile(unrelated, "keep\n");

      await assert.rejects(() => writePrivateFileAtomic(target, "data\n"));

      assert.equal(await fs.readFile(unrelated, "utf8"), "keep\n");
      assert.deepEqual((await fs.readdir(root)).filter((name) => name.startsWith("rename-target.") && name.endsWith(".tmp")), []);
    });

    await t.test("tree hardening never follows symlinks", async () => {
      const tree = path.join(root, "tree");
      const nested = path.join(tree, "nested");
      const file = path.join(nested, "data.json");
      const outside = path.join(root, "outside.txt");
      await fs.mkdir(nested, { recursive: true, mode: 0o775 });
      await fs.chmod(tree, 0o775);
      await fs.chmod(nested, 0o775);
      await fs.writeFile(file, "data\n", { mode: 0o664 });
      await fs.chmod(file, 0o664);
      await fs.writeFile(outside, "outside\n", { mode: 0o664 });
      await fs.chmod(outside, 0o664);
      await fs.symlink(outside, path.join(tree, "outside-link"));

      assert.deepEqual(await hardenPrivateTree(tree), []);

      assert.equal(mode(await fs.stat(tree)), 0o700);
      assert.equal(mode(await fs.stat(nested)), 0o700);
      assert.equal(mode(await fs.stat(file)), 0o600);
      assert.equal(mode(await fs.stat(outside)), 0o664);
      assert.equal((await fs.lstat(path.join(tree, "outside-link"))).isSymbolicLink(), true);
    });
  } finally {
    process.umask(previousUmask);
    if (root) await fs.rm(root, { recursive: true, force: true });
  }
});
