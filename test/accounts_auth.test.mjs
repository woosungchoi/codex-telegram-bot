import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { signInAccount, inspectAccount } from "../src/accounts/auth.js";
import { accountFixture } from "./helpers/accounts_fixture.mjs";
import { accountHome } from "../src/accounts/store.js";

function fakeLogin({ complete = true, url = "https://auth.openai.com/codex/device" } = {}) {
  const calls = [];
  return { calls, connect: async (config) => {
    let notify;
    return {
      onNotification(fn) { notify = fn; return () => {}; },
      async request(method) {
        calls.push(method);
        if (method === "account/login/start") {
          if (complete) {
            await fs.writeFile(path.join(config.codexHome, "auth.json"), "TEST_TOKEN_SENTINEL");
            // Exercise completion before the start request resolves.
            notify({ method: "account/login/completed", params: { loginId: "login-1", success: true } });
          }
          return { type: "chatgptDeviceCode", loginId: "login-1", verificationUrl: url, userCode: "ABCD-1234" };
        }
        if (method === "account/read") return { account: { type: "chatgpt", planType: "plus", email: "private@example.invalid" } };
        return {};
      },
      async close() { calls.push("close"); }
    };
  } };
}

test("device login verifies completion and saves only non-secret metadata", async (t) => {
  const { config, store } = await accountFixture(t);
  const fake = fakeLogin();
  let code;
  const result = await signInAccount({ config, store, label: "Personal", connect: fake.connect, onCode: async (value) => { code = value; } });
  assert.equal(result.status, "ready");
  assert.equal(result.planType, "plus");
  assert.equal(code.userCode, "ABCD-1234");
  assert.equal((await fs.stat(path.join(accountHome(config, result.id), "auth.json"))).mode & 0o777, 0o600);
  assert.equal(fake.calls.at(-1), "close");
  assert.doesNotMatch(JSON.stringify(await store.read()), /TEST_TOKEN|ABCD|private@example/);
  assert.equal(await fs.readFile(path.join(config.codexHome, "auth.json"), "utf8"), "HOST_TOKEN_SENTINEL");
});

test("cancelled login deletes the staging account while keeping the existing host login", async (t) => {
  const { config, store } = await accountFixture(t);
  const fake = fakeLogin({ complete: false });
  const abort = new AbortController();
  await assert.rejects(signInAccount({ config, store, connect: fake.connect, signal: abort.signal, onCode: async () => abort.abort() }), { name: "AbortError" });
  assert.deepEqual((await store.list()).map((a) => a.id), ["default"]);
  assert.ok(fake.calls.includes("account/login/cancel"));
  assert.equal(await fs.readFile(path.join(config.codexHome, "auth.json"), "utf8"), "HOST_TOKEN_SENTINEL");
});

test("expired and malformed device logins clean up staging credentials", async (t) => {
  const { config, store } = await accountFixture(t);
  await assert.rejects(signInAccount({ config, store, connect: fakeLogin({ complete: false }).connect, onCode: async () => {}, timeoutMs: 5 }), /expired/);
  await assert.rejects(signInAccount({ config, store, connect: fakeLogin({ url: "http://localhost/secret" }).connect, onCode: async () => assert.fail("must not expose URL") }), /Invalid device/);
  assert.equal((await store.list()).length, 1);
});

test("account status uses rate-limit reset timestamps and never returns tokens", async () => {
  const result = await inspectAccount({ codexHome: "/unused" }, "default", { connect: async () => ({
    async request(method) {
      return method === "account/read" ? { account: { type: "chatgpt", planType: "pro" } }
        : { rateLimits: { primary: { usedPercent: 100, resetsAt: 2000000000 } } };
    }, async close() {}
  }) });
  assert.equal(result.cooldownUntil, 2000000000000);
  assert.equal(result.failureCode, "quota");
});
