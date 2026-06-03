import test from "node:test";
import assert from "node:assert/strict";
import { splitMarkdownAware, splitText } from "../src/telegram/split.js";

test("splitText prefers line or word boundaries", () => {
  assert.deepEqual(splitText("alpha beta\ngamma delta", 12), ["alpha beta", "gamma delta"]);
});

test("splitText hard-splits oversized words", () => {
  assert.deepEqual(splitText("abcdefghij", 4), ["abcd", "efgh", "ij"]);
});

test("splitMarkdownAware keeps fenced code chunks syntactically closed", () => {
  const chunks = splitMarkdownAware("```js\nconst value = 1;\nconst next = 2;\n```\nDone", 24);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => (chunk.match(/```/g) ?? []).length % 2 === 0));
});

test("splitMarkdownAware keeps long markdown chunks within the max boundary", () => {
  const chunks = splitMarkdownAware("alpha ".repeat(200), 80);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 80));
});

test("splitMarkdownAware respects Telegram-sized max char boundaries", () => {
  const chunks = splitMarkdownAware("x".repeat(9000), 4096);
  assert.equal(chunks.length, 3);
  assert.ok(chunks.every((chunk) => chunk.length <= 4096));
});
