import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";

const execute = promisify(execFile);
async function tree(root, ref) {
  const { stdout } = await execute(
    "git",
    ["ls-tree", "-rz", "--full-tree", ref],
    { cwd: root, maxBuffer: 16 * 1024 * 1024 },
  );
  return new Map(
    stdout
      .split("\0")
      .filter(Boolean)
      .map((line) => {
        const tab = line.indexOf("\t"),
          [mode, type, hash] = line.slice(0, tab).split(" ");
        return [line.slice(tab + 1), `${mode} ${type} ${hash}`];
      }),
  );
}

export async function compareRepositories(
  root,
  privateRef,
  publicRef,
  { metadataPath } = {},
) {
  const [privateTree, publicTree] = await Promise.all([
    tree(root, privateRef),
    tree(root, publicRef),
  ]);
  const differences = [];
  for (const file of [
    ...new Set([...privateTree.keys(), ...publicTree.keys()]),
  ].sort()) {
    if (file === metadataPath) continue;
    const privateBlob = privateTree.get(file) ?? null,
      publicBlob = publicTree.get(file) ?? null;
    if (privateBlob !== publicBlob)
      differences.push({ file, privateBlob, publicBlob });
  }
  return differences;
}

export function reviewDifferences(differences, manifest) {
  if (manifest.version !== 1 || !Array.isArray(manifest.differences))
    throw new Error("Invalid repository sync manifest.");
  const approved = new Map(),
    errors = [];
  for (const entry of manifest.differences) {
    if (!entry.file || !entry.reason?.trim() || approved.has(entry.file))
      throw new Error(
        "Each approved difference needs a unique file and a reason.",
      );
    approved.set(entry.file, entry);
  }
  for (const difference of differences) {
    const expected = approved.get(difference.file);
    if (!expected) errors.push(`Unreviewed difference: ${difference.file}`);
    else if (
      expected.privateBlob !== difference.privateBlob ||
      expected.publicBlob !== difference.publicBlob
    )
      errors.push(`Changed approved difference: ${difference.file}`);
    approved.delete(difference.file);
  }
  for (const file of approved.keys())
    errors.push(`Resolved difference still in manifest: ${file}`);
  return errors;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const [privateRef, publicRef, manifestPath] = process.argv.slice(2);
  if (!privateRef || !publicRef || !manifestPath)
    throw new Error(
      "Usage: node scripts/repository-sync.mjs <private-ref> <public-ref> <manifest.json>",
    );
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const actualMetadataPath = path
    .relative(process.cwd(), path.resolve(manifestPath))
    .split(path.sep)
    .join("/");
  if (manifest.metadataPath && manifest.metadataPath !== actualMetadataPath) {
    throw new Error("metadataPath may exclude only the manifest file itself.");
  }
  const differences = await compareRepositories(
    process.cwd(),
    privateRef,
    publicRef,
    { metadataPath: manifest.metadataPath },
  );
  const errors = reviewDifferences(differences, manifest);
  console.log(
    JSON.stringify(
      {
        privateRef,
        publicRef,
        reviewedDifferences: differences.length,
        errors,
      },
      null,
      2,
    ),
  );
  process.exitCode = errors.length ? 1 : 0;
}
