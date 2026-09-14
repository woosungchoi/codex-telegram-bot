import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "@typescript/typescript6";
import { sourceFiles } from "./coverage-summary.mjs";

export async function architectureProblems(root) {
  const files = await sourceFiles(path.join(root, "src")),
    known = new Set(files),
    edges = new Map(),
    errors = [];
  for (const file of files) {
    const parsed = ts.createSourceFile(
      file,
      await fs.readFile(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const imports = [];
    for (const statement of parsed.statements) {
      if (
        !ts.isImportDeclaration(statement) &&
        !ts.isExportDeclaration(statement)
      )
        continue;
      const specifier = statement.moduleSpecifier;
      if (
        specifier &&
        ts.isStringLiteral(specifier) &&
        specifier.text.startsWith(".")
      ) {
        const target = path.resolve(path.dirname(file), specifier.text);
        if (known.has(target)) imports.push(target);
      }
    }
    edges.set(file, imports);
    const relative = path.relative(root, file).split(path.sep).join("/");
    for (const target of imports) {
      const to = path.relative(root, target).split(path.sep).join("/");
      if (
        /^src\/(workspace|forum|accounts|ui)\//.test(relative) &&
        /^src\/runtime(?:\/|\.js$)/.test(to)
      )
        errors.push(`${relative} imports runtime composition: ${to}`);
      if (
        /^src\/workspace\/.*_controller\.js$/.test(relative) &&
        /^src\/workspace\/.*_controller\.js$/.test(to)
      )
        errors.push(`${relative} imports a sibling controller: ${to}`);
    }
  }
  const visited = new Set(),
    active = new Set(),
    stack = [];
  function visit(file) {
    if (active.has(file)) {
      errors.push(
        `Import cycle: ${[...stack.slice(stack.indexOf(file)), file].map((item) => path.relative(root, item)).join(" -> ")}`,
      );
      return;
    }
    if (visited.has(file)) return;
    active.add(file);
    stack.push(file);
    for (const next of edges.get(file) || []) visit(next);
    stack.pop();
    active.delete(file);
    visited.add(file);
  }
  for (const file of files) visit(file);
  return { files: files.length, errors };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const result = await architectureProblems(process.cwd());
  for (const error of result.errors) console.error(error);
  console.log(
    `Architecture: ${result.files} source files, ${result.errors.length} violations.`,
  );
  process.exitCode = result.errors.length ? 1 : 0;
}
