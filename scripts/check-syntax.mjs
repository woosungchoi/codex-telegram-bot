import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const appRoot = process.cwd();
const targets = ["eslint.config.js", "src", "scripts", "test"];

const files = (await collectFiles(targets)).sort();
let failed = false;

for (const file of files) {
  try {
    await execFileAsync(process.execPath, ["--check", file], { cwd: appRoot });
  } catch (error) {
    failed = true;
    process.stderr.write(`${file}\n`);
    if (error.stdout)
      process.stderr.write(error.stdout);
    if (error.stderr)
      process.stderr.write(error.stderr);
  }
}

if (failed)
  process.exitCode = 1;
else
  console.log(`Syntax checked ${files.length} JavaScript files.`);

async function collectFiles(paths) {
  const files = [];
  for (const target of paths) {
    await collectPath(path.join(appRoot, target), files);
  }
  return files.map((file) => path.relative(appRoot, file).split(path.sep).join("/"));
}

async function collectPath(targetPath, files) {
  const stat = await fs.stat(targetPath);
  if (stat.isFile()) {
    if (/\.[cm]?js$/u.test(targetPath))
      files.push(targetPath);
    return;
  }
  if (!stat.isDirectory())
    return;
  for (const entry of await fs.readdir(targetPath, { withFileTypes: true })) {
    await collectPath(path.join(targetPath, entry.name), files);
  }
}
