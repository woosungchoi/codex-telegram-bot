import test from "node:test";
import assert from "node:assert/strict";
import {
  createTelegramCommandMenu,
  telegramCommands
} from "../src/telegram/command_menu.js";

test("Telegram command menu exposes the stable compact command set", () => {
  assert.deepEqual(telegramCommands("en").map(({ command }) => command), [
    "menu", "projects", "topics", "forum_setup", "sessions", "tasks", "dashboard", "mcp", "new", "resume", "status", "usage", "queue", "steer", "settings", "accounts", "reauth", "tools", "skills", "stop", "help"
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

test("ops menu is opt-in in every registration scope", async () => {
  assert.ok(!telegramCommands('en').some(({ command }) => command === 'ops'));
  assert.ok(telegramCommands('ko', { operationalStatusEnabled: true }).some(({ command, description }) => command === 'ops' && description === '운영 현황'));
  const calls = [];
  await createTelegramCommandMenu({
    bot: { telegram: { setMyCommands: async (commands) => calls.push(commands) } },
    language: () => 'en', operationalStatusEnabled: true,
    timing: { sleep: async () => {}, withTimeout: (promise) => promise }, summarizeError: String
  }).registerTelegramCommands();
  assert.ok(calls.length > 1);
  assert.ok(calls.every((commands) => commands.some(({ command }) => command === 'ops')));
});
