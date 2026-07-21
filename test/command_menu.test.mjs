import test from "node:test";
import assert from "node:assert/strict";
import {
  createTelegramCommandMenu,
  telegramCommands
} from "../src/telegram/command_menu.js";

test("Telegram command menu exposes the stable compact command set", () => {
  assert.deepEqual(telegramCommands("en").map(({ command }) => command), [
    "menu", "new", "resume", "status", "queue", "settings", "tools", "skills", "stop", "help"
  ]);
});

test("command menu registers the default and localized Telegram scopes", async () => {
  const calls = [];
  const menu = createTelegramCommandMenu({
    bot: { telegram: { setMyCommands: async (...args) => calls.push(args) } },
    language: () => "en",
    timing: { sleep: async () => {}, withTimeout: (promise) => promise },
    summarizeError: String
  });
  await menu.registerTelegramCommands();
  assert.ok(calls.length >= 2);
  assert.equal(calls[0][0][0].command, "menu");
});
