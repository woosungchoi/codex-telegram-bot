import test from "node:test";
import assert from "node:assert/strict";
import {
  collapseExcessBlankLines,
  formatOptional,
  safeFilename,
  trimTrailingSpaces,
  truncate,
  unique
} from "../src/utils/text.js";
import { formatDurationSeconds, timestampForFilename } from "../src/utils/time.js";

test("text cleanup helpers normalize whitespace", () => {
  assert.equal(trimTrailingSpaces("a  \n b\t"), "a\n b");
  assert.equal(collapseExcessBlankLines("a\n\n\n\nb"), "a\n\nb");
});

test("formatOptional and truncate keep display values compact", () => {
  assert.equal(formatOptional(true), "true");
  assert.equal(formatOptional(false), "false");
  assert.equal(formatOptional(undefined), "default");
  assert.equal(truncate("abcdef", 6), "abcdef");
  assert.equal(truncate("abcdef", 5), "ab...");
});

test("filename helpers produce filesystem-safe values", () => {
  assert.equal(timestampForFilename("2026-06-03T01:02:03.004Z"), "2026-06-03T01-02-03-004Z");
  assert.equal(safeFilename("bad/name:with spaces"), "bad_name_with_spaces");
  assert.equal(safeFilename(""), "unknown");
});

test("collection and duration helpers keep runtime display behavior", () => {
  assert.deepEqual(unique(["a", "b", "a"]), ["a", "b"]);
  assert.equal(formatDurationSeconds(90061), "1d 1h 1m 1s");
});
