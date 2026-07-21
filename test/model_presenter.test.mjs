import test from "node:test";
import assert from "node:assert/strict";
import { createModelPresenter } from "../src/ui/model_presenter.js";

function createFixture() {
  const chat = { options: {}, outputSchema: { type: "object" } };
  const options = {
    model: "gpt-test",
    modelReasoningEffort: "high",
    serviceTier: "fast",
    workingDirectory: "/tmp",
    sandboxMode: "workspace-write",
    approvalPolicy: "never"
  };
  return createModelPresenter({
    settings: { config: { codexModelsCacheFile: "/tmp/missing", codexReasoningEffort: "medium" } },
    state: { chats: { chat } },
    chats: {
      effectiveModelSlug: () => "gpt-test",
      get: () => chat,
      getEffectiveOptions: () => options
    },
    localization: {
      language: () => "en",
      locale: () => "en-US",
      text: (key) => key,
      timeZone: () => "UTC"
    },
    formatting: {
      keyValue: (title, rows) => `${title}\n${rows.map(([key, value]) => `${key}:${value}`).join("\n")}`,
      optional: (value) => value ?? "default"
    }
  });
}

test("model presenter renders effective options and schema state", () => {
  const presenter = createFixture();
  const html = presenter.formatOptionsHtml("chat");
  assert.match(html, /model:gpt-test/);
  assert.match(html, /serviceTier:fast/);
  assert.match(html, /outputSchema:enabled/);
});

test("model presenter reports Fast support from the supplied catalog", () => {
  const presenter = createFixture();
  const html = presenter.formatFastStatusHtml("chat", [
    { slug: "gpt-test", fastSupported: true },
    { slug: "slow", fastSupported: false }
  ]);
  assert.match(html, /fast-supported models:gpt-test/);
});
