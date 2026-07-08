import test from "node:test";
import assert from "node:assert/strict";
import { isRegisteredTelegramCommandText } from "../src/telegram_commands.js";
import { botCommandMessage } from "./helpers/fixture.mjs";

test("registered commands are recognized", () => {
  assert.equal(isRegisteredTelegramCommandText({ text: "/start", entities: [{ type: "bot_command", offset: 0, length: 6 }] }), true);
  assert.equal(isRegisteredTelegramCommandText({ text: "/queue_mode_safe", entities: [{ type: "bot_command", offset: 0, length: 16 }] }), true);
  assert.equal(isRegisteredTelegramCommandText({ text: "/recovery_status", entities: [{ type: "bot_command", offset: 0, length: 16 }] }), true);
  assert.equal(isRegisteredTelegramCommandText(botCommandMessage("/skills")), true);
  assert.equal(isRegisteredTelegramCommandText({ text: "/start@my_bot", entities: [{ type: "bot_command", offset: 0, length: 13 }] }), true);
});

test("slash-prefixed paths and unknown commands are treated as normal text", () => {
  assert.equal(isRegisteredTelegramCommandText({ text: "/home/openclaw/.openclaw/ahahhss 이 폴더를 봐줘", entities: [{ type: "bot_command", offset: 0, length: 36 }] }), false);
  assert.equal(isRegisteredTelegramCommandText({ text: "/tmp/project check this" }), false);
  assert.equal(isRegisteredTelegramCommandText({ text: "/unknown_command please handle this", entities: [{ type: "bot_command", offset: 0, length: 16 }] }), false);
});

test("ordinary text is not a command", () => {
  assert.equal(isRegisteredTelegramCommandText({ text: "please inspect /home/openclaw" }), false);
  assert.equal(isRegisteredTelegramCommandText({ text: "" }), false);
});

test("commands with bot mention only match registered command name", () => {
  assert.equal(isRegisteredTelegramCommandText(botCommandMessage("/queue@my_bot", 13)), true);
  assert.equal(isRegisteredTelegramCommandText(botCommandMessage("/skills@my_bot", 14)), true);
  assert.equal(isRegisteredTelegramCommandText(botCommandMessage("/not_registered@my_bot", 22)), false);
});

test("leading whitespace slash paths are normal text unless registered command", () => {
  assert.equal(isRegisteredTelegramCommandText({ text: "   /tmp/project check" }), false);
  assert.equal(isRegisteredTelegramCommandText({ text: "   /status" }), true);
});
