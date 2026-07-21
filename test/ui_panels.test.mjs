import test from "node:test";
import assert from "node:assert/strict";
import {
  createRuntimePanelViews,
  formatKeyValueHtml,
  formatSettingPanelHtml
} from "../src/ui/panels.js";

const views = createRuntimePanelViews({
  text: (key) => key,
  formatText: (key, values) => `${key}:${values.title}`
});

test("setting panel escapes current value and keeps description", () => {
  const html = formatSettingPanelHtml({
    titleText: "Sandbox",
    current: "workspace-write & more",
    description: "Choose how Codex can touch files."
  });
  assert.match(html, /<b>Sandbox<\/b>/);
  assert.match(html, /Current: <code>workspace-write &amp; more<\/code>/);
  assert.match(html, /Choose how Codex can touch files\./);
});

test("key-value panels escape labels and values", () => {
  assert.equal(
    formatKeyValueHtml("Status & health", [["unsafe <key>", "value & more"]]),
    "<b>Status &amp; health</b>\nunsafe &lt;key&gt;: <code>value &amp; more</code>"
  );
});

test("runtime panel views render supplied view models without runtime state", () => {
  const html = views.renderMainPanelHtml({
    details: {
      threadId: "thread<&",
      active: true,
      queued: 2,
      queueMode: "safe",
      queuePaused: false
    },
    options: {
      model: "model<&",
      modelReasoningEffort: "high",
      workingDirectory: "/tmp/<work>"
    },
    transport: "sdk"
  });

  assert.match(html, /Thread: <code>thread&lt;&amp;<\/code>/);
  assert.match(html, /Queue: <code>2 pending, mode=safe, paused=no<\/code>/);
  assert.match(html, /Model: <code>model&lt;&amp;<\/code>/);
  assert.match(html, /mainInstruction$/);
});

test("runtime panel views keep localized preference and tool rendering", () => {
  const timeZone = views.renderTimeZoneGroupPanelHtml("asia", "Asia/Seoul");
  assert.match(timeZone, /settingPanelTitle:timeZoneTitle · 🌏 Asia/);
  assert.match(timeZone, /Current: <code>Asia\/Seoul<\/code>/);
  assert.match(timeZone, /timeZoneRegionDescription/);

  const tools = views.renderToolsPanelHtml({
    threadId: "",
    savedChats: 3,
    pendingTurns: 2
  });
  assert.match(tools, /Thread: <code>not started<\/code>/);
  assert.match(tools, /Saved chats: <code>3<\/code>/);
  assert.match(tools, /Pending turns: <code>2<\/code>/);
});
