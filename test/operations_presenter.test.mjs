import test from "node:test";
import assert from "node:assert/strict";
import { createOperationsPresenter } from "../src/ui/operations_presenter.js";

function createFixture(readOutput = async () => ({ ok: true, output: "line one\nsecret" })) {
  return createOperationsPresenter({
    settings: {
      config: {
        allowedUserIds: new Set(["1"]),
        uploadDir: "/tmp/uploads"
      },
      runtimeValue(key) {
        if (key === "logsMaxLines") return 40;
        if (key === "maxTelegramChars") return 4096;
        return "default";
      }
    },
    threadCache: new Map(),
    chats: { get: () => ({}), getEffectiveOptions: () => ({}) },
    queue: { mode: () => "safe" },
    telegram: { getCommandArgs: (ctx) => ctx.args ?? "" },
    formatting: {
      bytes: (value) => `${value} B`,
      count: String,
      dateTime: () => "date",
      keyValue: (title, rows) => `${title}\n${rows.map(([key, value]) => `${key}:${value}`).join("\n")}`,
      optional: String,
      redactText: (value) => value.replaceAll("secret", "[redacted]")
    },
    commands: { readOutput }
  });
}

test("operations presenter redacts bounded journal output", async () => {
  const html = await createFixture().formatLogsHtml({ args: "2" });
  assert.match(html, /line one/);
  assert.match(html, /\[redacted\]/);
  assert.doesNotMatch(html, /secret/);
});

test("operations presenter keeps upload cleanup confirmation details", () => {
  const html = createFixture().formatUploadCleanupPlanHtml({
    dryRun: true,
    retentionDays: 7,
    maxBytes: 0,
    candidates: [{ path: "/tmp/uploads/old.pdf", bytes: 5 }],
    preserved: [],
    totalBytes: 5,
    candidateBytes: 5
  }, { id: "plan", expiresAt: "date" });
  assert.match(html, /old\.pdf/);
  assert.match(html, /Confirm upload cleanup/);
});
