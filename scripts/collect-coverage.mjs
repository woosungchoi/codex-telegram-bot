import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { sourceFiles, summarizeCoverage } from "./coverage-summary.mjs";

if (Number(process.versions.node.split(".")[0]) < 22)
  throw new Error(
    "Coverage reporting requires Node.js 22 or newer. Use npm test on older supported versions.",
  );
const root = process.cwd(),
  directory = path.join(root, "coverage");
await fs.mkdir(directory, { recursive: true });
const report = path.join(directory, "lcov.info");
await fs.rm(report, { force: true });
const child = spawn(
  process.execPath,
  [
    "--test",
    "--experimental-test-coverage",
    "--test-coverage-include=src/**",
    "--test-reporter=spec",
    "--test-reporter-destination=stdout",
    "--test-reporter=lcov",
    `--test-reporter-destination=${report}`,
  ],
  { stdio: "inherit" },
);
const status = await new Promise((resolve, reject) => {
  child.on("error", reject);
  child.on("exit", (code) => resolve(code ?? 1));
});
const sources = (await sourceFiles(path.join(root, "src"))).map((file) =>
  path.relative(root, file).split(path.sep).join("/"),
);
const summary = summarizeCoverage(
  await fs.readFile(report, "utf8"),
  sources,
  root,
);
await fs.writeFile(
  path.join(directory, "summary.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
);
console.log(
  `Coverage measured ${summary.reportedFileCount}/${summary.sourceFileCount} source files. Unreported: ${summary.unreportedFiles.join(", ") || "none"}`,
);
const required = [
  "src/runtime/route_composition.js",
  "src/runtime/execution_composition.js",
];
const missing = required.filter(
  (file) =>
    !summary.files.some(
      (entry) => entry.file === file && entry.coveredLines > 0,
    ),
);
if (missing.length)
  console.error(`Required integration coverage missing: ${missing.join(", ")}`);
process.exitCode = status || (missing.length ? 1 : 0);
