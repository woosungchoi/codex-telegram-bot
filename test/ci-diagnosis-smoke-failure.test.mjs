import test from "node:test";
import assert from "node:assert/strict";

test("intentional CI diagnosis smoke failure", () => {
  assert.equal(
    process.env.CODEX_TELEGRAM_BOT_DIAGNOSIS_SMOKE,
    "pass",
    "Intentional failure for Codex CI Diagnosis E2E smoke test. This PR will be closed after the diagnosis comment is verified."
  );
});
