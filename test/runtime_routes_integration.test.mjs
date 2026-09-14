import test from "node:test";
import assert from "node:assert/strict";
import { runtimeRoutesFixture } from "./helpers/runtime_routes_fixture.mjs";

async function press(f, data) {
  assert.ok(f.buttons().some((b) => b.callback_data === data), `Missing visible action ${data}`);
  await f.click(data);
  assert.doesNotMatch(f.messages.at(-1)?.html || "", /Telegram bot error/);
}
function previous(f, expected) {
  const buttons = f.buttons().filter((b) => b.text.startsWith("⬅️ "));
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].callback_data, expected);
}

test("composed Telegram routes navigate settings, mutate an option, return and close", async (t) => {
  const f = await runtimeRoutesFixture(t);
  await f.send("/menu");
  await press(f, "p:settings");
  previous(f, "p:main");
  await press(f, "p:settings_runtime");
  await press(f, "p:settings_runtime_output");
  previous(f, "p:settings_runtime");
  const setting = f.buttons().find((b) => b.callback_data.startsWith("set:runtime_reactions:"));
  assert.ok(setting);
  await press(f, setting.callback_data);
  assert.ok(Object.hasOwn(f.state.runtime, "telegramReactionsEnabled"));
  previous(f, "p:settings");
  await press(f, "p:settings");
  await press(f, "p:main");
  await press(f, "ui:close:menu");
  assert.equal(f.buttons().length, 0);
});

test("composed tools and workspace menus preserve their entry route", async (t) => {
  const f = await runtimeRoutesFixture(t);
  await f.send("/menu");
  await press(f, "p:tools");
  for (const action of ["health", "doctor", "logs", "logs_error", "whoami", "config"]) {
    await press(f, `tool:${action}`);
    previous(f, "p:tools");
    await press(f, "p:tools");
  }
  await press(f, "w:mcp:tools");
  await f.press("이전");
  assert.ok(f.buttons().some((b) => b.callback_data === "tool:health"));
});

test("account usage routing preserves account selection and the accounts parent", async (t) => {
  const f = await runtimeRoutesFixture(t);
  const account = await f.store.create("Second");
  await f.store.update(account.id, { status: "ready" });
  await f.send("/menu");
  await press(f, "acct:list");
  await press(f, "acct:usage:default:accounts");
  await press(f, `acct:usage:${account.id}:accounts`);
  previous(f, "acct:list");
  assert.equal(f.r.getChatState("1").accountId, "default");
  assert.deepEqual(f.usageReads, ["default", account.id]);
  await press(f, "acct:list");
  await press(f, "p:main");
  await f.send("/usage");
  previous(f, "p:main");
});

test("full middleware rejects a foreign user, isolates topics, and consumes stale input safely", async (t) => {
  const f = await runtimeRoutesFixture(t);
  await f.send("/projects", { threadId: 7 });
  const old = globalThis.structuredClone(f.messages.at(-1));
  const button = f.buttons().find((b) => b.text.includes("현재"));
  assert.ok(button);
  await f.click(button.callback_data, old, { userId: 999 });
  assert.equal(f.messages.length, 1);
  await f.click(button.callback_data, old, { threadId: 8 });
  assert.match(f.apiCalls.findLast((call) => call.method === "answerCallbackQuery").payload.text, /만료/);
  assert.equal(f.messages.length, 1);
  assert.equal(f.messages.at(-1).html, old.html);
  await f.click(button.callback_data, old);
  await f.send("/accounts", { threadId: 7 });
  await f.send("do work", { threadId: 7 });
  assert.deepEqual(f.forwarded, ["do work"]);
  await f.send("/projects", { threadId: 7 });
  const expired = globalThis.structuredClone(f.messages.at(-1));
  const callback = f.buttons()[0].callback_data;
  f.clock.now += 16 * 60_000;
  await f.click(callback, expired);
  assert.match(f.apiCalls.findLast((call) => call.method === "answerCallbackQuery").payload.text, /만료/);
  assert.equal(f.messages.at(-1).html, expired.html);
});
