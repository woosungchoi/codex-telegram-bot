import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "@typescript/typescript6";
import { sourceFiles } from "./coverage-summary.mjs";

// Inspect presentation boundaries, not arbitrary strings: command syntax,
// callback IDs, SDK output and diagnostic logs must retain their exact values.
export function uiLocalizationProblems(source, messages, file = "source.js") {
  const parsed = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const problems = [];
  const report = (node, message) => {
    const { line } = parsed.getLineAndCharacterOfPosition(
      node.getStart(parsed),
    );
    problems.push(`${file}:${line + 1}: ${message}`);
  };
  function checkKey(node) {
    if (ts.isConditionalExpression(node)) {
      checkKey(node.whenTrue);
      checkKey(node.whenFalse);
    } else if (
      ts.isStringLiteralLike(node) &&
      typeof messages[node.text] !== "string"
    ) {
      report(node, `Unknown translation key: ${node.text}`);
    }
  }
  function checkCopy(node) {
    if (!node) return;
    if (ts.isConditionalExpression(node)) {
      checkCopy(node.whenTrue);
      checkCopy(node.whenFalse);
      return;
    }
    const fragments = ts.isStringLiteralLike(node)
      ? [node.text]
      : ts.isTemplateExpression(node)
        ? [
            node.head.text,
            ...node.templateSpans.map((span) => span.literal.text),
          ]
        : [];
    for (const fragment of fragments) {
      const visible = fragment.replace(/<[^>]*>/g, "").trim();
      // Numeric choices, symbolic controls, command syntax, paths and URLs.
      if (
        !/[\p{L}]/u.test(visible) ||
        /^(?:\/|https?:\/\/|[A-Z_][A-Z0-9_]+$)/.test(visible)
      )
        continue;
      report(node, "Move fixed UI text into a locale key.");
      break;
    }
  }
  function visit(node) {
    if (
      ts.isNewExpression(node) &&
      node.expression.getText(parsed) === "LocalizedError"
    ) {
      if (node.arguments?.[0]) checkKey(node.arguments[0]);
    }
    if (ts.isCallExpression(node)) {
      const name = ts.isPropertyAccessExpression(node.expression)
        ? node.expression.name.text
        : node.expression.getText(parsed);
      if (name === "msg" && node.arguments[0]) checkKey(node.arguments[0]);
      if (name === "textFor" && node.arguments[1]) checkKey(node.arguments[1]);
      if (["t", "text", "formatText", "forLanguage"].includes(name)) {
        const key = node.arguments[name === "forLanguage" ? 1 : 0];
        if (
          key &&
          ts.isStringLiteralLike(key) &&
          /^(ui|units|skills|usage|timeZoneCity|timeZoneGroup|errors|prompt)\./.test(
            key.text,
          )
        )
          checkKey(key);
      }
      if (
        [
          "b",
          "answerCbQuery",
          "reply",
          "formatKeyValueHtml",
          "keyValue",
        ].includes(name)
      )
        checkCopy(node.arguments[0]);
      if (
        [
          "replyHtml",
          "editOrReplyHtml",
          "editStrict",
          "sendHtmlMessage",
        ].includes(name)
      )
        checkCopy(node.arguments[1]);
    }
    if (ts.isObjectLiteralExpression(node)) {
      const properties = node.properties.filter(ts.isPropertyAssignment);
      if (
        properties.some((property) =>
          ["callback_data", "url"].includes(property.name.getText(parsed)),
        )
      ) {
        for (const property of properties) {
          if (["text", "label"].includes(property.name.getText(parsed)))
            checkCopy(property.initializer);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  return problems;
}

export async function checkUiLocalization(root) {
  const messages = JSON.parse(
    await fs.readFile(path.join(root, "src/locales/en.json"), "utf8"),
  );
  const files = await sourceFiles(path.join(root, "src"));
  const problems = [];
  for (const file of files) {
    problems.push(
      ...uiLocalizationProblems(
        await fs.readFile(file, "utf8"),
        messages,
        path.relative(root, file),
      ),
    );
  }
  return { files: files.length, problems };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const { files, problems } = await checkUiLocalization(process.cwd());
  for (const problem of problems) console.error(problem);
  console.log(
    `UI localization: ${files} source files, ${problems.length} violations.`,
  );
  process.exitCode = problems.length ? 1 : 0;
}
