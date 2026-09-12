import test from "node:test";
import assert from "node:assert/strict";
import { consumeAccountResetCredit, resetCreditChoices } from "../src/accounts/reset_credits.js";
import { accountHome } from "../src/accounts/store.js";
import { accountFixture } from "./helpers/accounts_fixture.mjs";

test("reset consumption uses the chosen account and exact credit and idempotency key without starting a turn", async (t) => {
  const f = await accountFixture(t);
  const account = await f.store.create("Work");
  const calls = [];
  let scoped, closed = 0;
  const result = await consumeAccountResetCredit({ ...f.config, codexEnv: { OPENAI_API_KEY: "DO_NOT_INHERIT" } }, account.id,
    { idempotencyKey: "same-logical-attempt", creditId: "opaque/id:preserved" }, {
      connect: async (config) => {
        scoped = config;
        return {
          request: async (method, params) => {
            calls.push({ method, params });
            return method === "account/read" ? { account: { type: "chatgpt" } } : { outcome: "reset", token: "DO_NOT_RETURN" };
          },
          close: async () => { closed++; }
        };
      }
    });
  assert.equal(scoped.codexEnv.CODEX_HOME, accountHome(f.config, account.id));
  assert.equal(scoped.codexEnv.OPENAI_API_KEY, undefined);
  assert.equal(scoped.codexAuthFileStore, true);
  assert.deepEqual(calls, [
    { method: "account/read", params: { refreshToken: false } },
    { method: "account/rateLimitResetCredit/consume", params: { idempotencyKey: "same-logical-attempt", creditId: "opaque/id:preserved" } }
  ]);
  assert.deepEqual(result, { outcome: "reset" });
  assert.equal(closed, 1);
});

test("automatic selection omits creditId and all documented outcomes are retained", async () => {
  for (const outcome of ["reset", "alreadyRedeemed", "noCredit", "nothingToReset"]) {
    let closed = 0;
    const result = await consumeAccountResetCredit({}, "default", { idempotencyKey: "stable-key" }, {
      connect: async () => ({
        request: async (method, params) => {
          if (method === "account/read") return { account: { type: "chatgpt" } };
          assert.deepEqual(params, { idempotencyKey: "stable-key" });
          return { outcome };
        },
        close: async () => { closed++; }
      })
    });
    assert.deepEqual(result, { outcome });
    assert.equal(closed, 1);
  }
});

test("reset errors close the client, never retry implicitly, and reject non-ChatGPT auth", async () => {
  for (const failure of ["auth", "rpc", "unknown"]) {
    const calls = [];
    let closed = 0;
    await assert.rejects(consumeAccountResetCredit({}, "default", { idempotencyKey: "stable-key", creditId: "selected" }, {
      connect: async () => ({
        request: async (method) => {
          calls.push(method);
          if (method === "account/read") return { account: { type: failure === "auth" ? "apiKey" : "chatgpt" } };
          if (failure === "rpc") throw new Error("lost response");
          return { outcome: "futureOutcome" };
        },
        close: async () => { closed++; }
      })
    }));
    assert.equal(closed, 1);
    assert.equal(calls.filter((method) => method.endsWith("/consume")).length, failure === "auth" ? 0 : 1);
  }
});

test("invalid reset identifiers fail before connecting", async () => {
  for (const params of [{}, { idempotencyKey: " " }, { idempotencyKey: "valid", creditId: "" }, { idempotencyKey: "valid", creditId: 12 }]) {
    await assert.rejects(consumeAccountResetCredit({}, "default", params, { connect: async () => assert.fail("must not connect") }));
  }
});

test("credit choices require available supported unexpired IDs and use the authoritative count", () => {
  const credit = { id: "opaque", title: "A", status: "available", resetType: "codexRateLimits", expiresAt: null };
  for (const summary of [null, {}, { availableCount: 0, credits: [credit] }]) assert.deepEqual(resetCreditChoices(summary), []);
  const choices = resetCreditChoices({ availableCount: 8, credits: [
    credit, credit, null, { ...credit, id: "redeemed", status: "redeemed" },
    { ...credit, id: "redeeming", status: "redeeming" }, { ...credit, id: "unknown", resetType: "unknown" },
    { ...credit, id: "expired", expiresAt: 1 }, { ...credit, id: "bad-date", expiresAt: "tomorrow" },
    { ...credit, id: "future", expiresAt: 99, description: "x".repeat(400) }, { ...credit, id: "" }
  ] }, 2000);
  assert.deepEqual(choices.map((item) => item.creditId || "automatic"), ["opaque", "future", "automatic"]);
  assert.equal(choices[1].description.length, 300);
  assert.deepEqual(resetCreditChoices({ availableCount: 2, credits: null }), [{ automatic: true }]);
  assert.deepEqual(resetCreditChoices({ availableCount: 2, credits: [] }), [{ automatic: true }]);
});
