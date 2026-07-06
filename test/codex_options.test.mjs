import test from "node:test";
import assert from "node:assert/strict";
import { mergeAdditionalDirectories } from "../src/codex/options.js";

test("upload directory is included in Codex additional directories", () => {
  assert.deepEqual(mergeAdditionalDirectories(["/workspace"], "/uploads"), ["/workspace", "/uploads"]);
});

test("additional directory merge removes duplicates", () => {
  assert.deepEqual(mergeAdditionalDirectories(["/uploads", "/workspace"], "/uploads"), ["/uploads", "/workspace"]);
});
