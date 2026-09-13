import test from "node:test";
import assert from "node:assert/strict";
import { completeMenuRows, renderMenu, MENU_DEFINITIONS, previousPanelFor } from "../src/ui/menu_definition.js";
import { textFor } from "../src/i18n.js";

test("explicit menu roles survive renamed labels and produce no internal Telegram fields", () => {
  const text = (key) => textFor("ko", key);
  const source = { protect_content: true, reply_markup: { inline_keyboard: [
    [{ role: "back", text: "Return to parent", callback_data: "p:tools" }],
    [{ role: "action", labelKey: "accounts.title", icon: "👥", callback_data: "acct:list", style: "primary" }]
  ] } };
  const rendered = renderMenu(source, { text, close: true });
  const buttons = rendered.reply_markup.inline_keyboard.flat();
  assert.equal(buttons.filter((button) => button.callback_data === "p:tools").length, 1);
  assert.equal(buttons.find((button) => button.callback_data === "acct:list").text, textFor("ko", "accounts.title"));
  assert.equal(buttons.find((button) => button.callback_data === "acct:list").style, "primary");
  assert.ok(buttons.every((button) => !("role" in button) && !("labelKey" in button) && !("icon" in button)));
  assert.equal(rendered.protect_content, true);
  assert.equal(source.reply_markup.inline_keyboard[0][0].text, "Return to parent");
  assert.deepEqual(renderMenu(rendered, { text, close: true }), rendered);
});

test("workspace navigation relies on roles, keeps action arguments and appends one close", () => {
  const back = { label: "Return", role: "back", action: { type: "sessions", accountId: "second" } };
  const rows = completeMenuRows([[back]], { back: { role: "back", action: { type: "home" } }, close: { role: "close" } });
  assert.deepEqual(rows, [[back], [{ role: "close" }]]);
  assert.equal(completeMenuRows(rows, { close: { role: "close" } }).length, 2);
});

test("panel definitions form a rooted parent tree and retain legacy dynamic ids", () => {
  for (const id of Object.keys(MENU_DEFINITIONS)) {
    const seen = new Set(); let current = id;
    while (current) {
      assert.ok(!seen.has(current)); seen.add(current);
      assert.ok(MENU_DEFINITIONS[current]); current = previousPanelFor(current);
    }
    assert.ok(seen.has("main"));
  }
  assert.equal(previousPanelFor("settings_timezone_asia"), "settings_timezone");
});
