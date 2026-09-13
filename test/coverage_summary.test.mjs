import test from "node:test";
import assert from "node:assert/strict";
import { summarizeCoverage } from "../scripts/coverage-summary.mjs";

test("coverage inventory distinguishes unexecuted source files from measured zero coverage", () => {
  const result = summarizeCoverage(
    "SF:/repo/src/a.js\nLF:10\nLH:0\nBRF:2\nBRH:0\nend_of_record\nSF:/repo/test/a.mjs\nLF:4\nLH:4\nend_of_record",
    ["src/a.js", "src/b.js"],
    "/repo",
  );
  assert.equal(result.sourceFileCount, 2);
  assert.equal(result.reportedFileCount, 1);
  assert.deepEqual(result.unreportedFiles, ["src/b.js"]);
  assert.equal(result.files[0].coveredLines, 0);
});
