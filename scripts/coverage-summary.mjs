import fs from "node:fs/promises";
import path from "node:path";

export async function sourceFiles(directory) {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(file)));
    else if (entry.name.endsWith(".js")) files.push(file);
  }
  return files.sort();
}

export function summarizeCoverage(lcov, sources, root) {
  const files = [];
  for (const block of lcov.split("end_of_record")) {
    const source = block.match(/^SF:(.+)$/m)?.[1];
    if (!source) continue;
    const file = path
      .relative(root, path.resolve(root, source))
      .split(path.sep)
      .join("/");
    if (!sources.includes(file)) continue;
    const numbers = (name) =>
      Number(block.match(new RegExp(`^${name}:(\\d+)$`, "m"))?.[1] || 0);
    files.push({
      file,
      lines: numbers("LF"),
      coveredLines: numbers("LH"),
      branches: numbers("BRF"),
      coveredBranches: numbers("BRH"),
    });
  }
  const reported = new Set(files.map((entry) => entry.file));
  return {
    sourceFileCount: sources.length,
    reportedFileCount: reported.size,
    unreportedFiles: sources.filter((file) => !reported.has(file)),
    files,
  };
}
