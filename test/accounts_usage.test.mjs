import test from "node:test";
import assert from "node:assert/strict";
import { readAccountUsage, formatAccountUsageHtml } from "../src/accounts/usage.js";
import { accountText } from "../src/accounts/messages.js";
import { accountHome } from "../src/accounts/store.js";
import { accountFixture } from "./helpers/accounts_fixture.mjs";

const weekly = { usedPercent: 52, windowDurationMins: 10080, resetsAt: 1789435487 };
const main = { limitId: "codex", primary: weekly, secondary: null };
const resetCredits = {
  availableCount: 3,
  credits: [{ id: "OPAQUE_CREDIT_ID", title: "Full reset", status: "available", expiresAt: 1789949489 }]
};
const usage = {
  account: { type: "chatgpt", email: "person@example.com", planType: "pro" },
  rateLimits: main,
  rateLimitResetCredits: resetCredits,
  rateLimitsByLimitId: {
    codex: main,
    codex_bengalfox: {
      limitName: "GPT-5.3-Codex-Spark",
      primary: { usedPercent: 3, windowDurationMins: 300, resetsAt: 1789196459 },
      secondary: { usedPercent: 1, windowDurationMins: 10080, resetsAt: 1789783259 }
    }
  },
  checkedAt: Date.parse("2026-09-12T05:59:00Z")
};
const options = {
  label: "Work", text: (key) => accountText("ko", key),
  formatDateTime: (ms) => new Date(ms).toISOString()
};

test("live usage reads use the selected account environment and never start a model turn", async (t) => {
  const f = await accountFixture(t);
  const managed = await f.store.create("Work");
  const calls = [];
  let closed = 0, scoped;
  const result = await readAccountUsage({ ...f.config, codexEnv: { OPENAI_API_KEY: "DO_NOT_INHERIT", KEEP: "yes" } }, managed.id, {
    now: () => usage.checkedAt,
    connect: async (config) => {
      scoped = config;
      return {
        request: async (method, params) => {
          calls.push({ method, params });
          return method === "account/read"
            ? { account: { ...usage.account, accessToken: "DO_NOT_RETURN" } } : usage;
        },
        close: async () => { closed++; }
      };
    }
  });
  assert.equal(scoped.codexEnv.CODEX_HOME, accountHome(f.config, managed.id));
  assert.equal(scoped.codexEnv.OPENAI_API_KEY, undefined);
  assert.equal(scoped.codexEnv.KEEP, "yes");
  assert.equal(scoped.codexAuthFileStore, true);
  assert.deepEqual(calls, [
    { method: "account/read", params: { refreshToken: false } },
    { method: "account/rateLimits/read", params: {} }
  ]);
  assert.deepEqual(result, usage);
  assert.equal(closed, 1);
  assert.doesNotMatch(JSON.stringify(result), /DO_NOT_RETURN/);
});

test("usage readers close their client on account and quota failures", async () => {
  for (const failedMethod of ["account/read", "account/rateLimits/read"]) {
    let closed = 0;
    await assert.rejects(readAccountUsage({}, "default", { connect: async () => ({
      request: async (method) => {
        if (method === failedMethod) throw new Error("request failed");
        return { account: usage.account };
      },
      close: async () => { closed++; }
    }) }), /request failed/);
    assert.equal(closed, 1);
  }
});

test("logged-out and API-key accounts do not make a ChatGPT quota request", async () => {
  for (const account of [null, { type: "apiKey" }]) {
    const calls = [];
    let closed = 0;
    const result = await readAccountUsage({}, "default", { connect: async () => ({
      request: async (method) => { calls.push(method); return { account }; },
      close: async () => { closed++; }
    }) });
    assert.deepEqual(calls, ["account/read"]);
    assert.equal(closed, 1);
    assert.equal(result.rateLimits, null);
    assert.equal(result.rateLimitResetCredits, null);
    assert.match(formatAccountUsageHtml(result, options), /ChatGPT 로그인이 필요/);
  }
});

test("usage renders a weekly primary window once and separate Spark windows with remaining quota", () => {
  const html = formatAccountUsageHtml(usage, options);
  assert.equal((html.match(/<b>Codex · 주간<\/b>/g) || []).length, 1);
  assert.match(html, /사용 52% · 남음 <b>48%<\/b>/);
  assert.match(html, /GPT-5.3-Codex-Spark · 5시간/);
  assert.match(html, /GPT-5.3-Codex-Spark · 주간/);
  assert.match(html, /남음 <b>97%<\/b>/);
  assert.match(html, /남음 <b>99%<\/b>/);
  assert.match(html, /2026-09-15T01:24:47.000Z/);
  assert.doesNotMatch(html, /<b>Codex · 5시간/);
  const kst = formatAccountUsageHtml(usage, {
    ...options,
    formatDateTime: (ms) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit" }).format(ms)
  });
  assert.match(kst, /초기화: <code>10:24<\/code>/);
});

test("legacy and map-only responses escape text and keep missing quota values unknown", () => {
  const html = formatAccountUsageHtml({
    ...usage, rateLimits: null,
    rateLimitsByLimitId: { codex: { limitName: "<Codex & Work>", primary: { usedPercent: null, resetsAt: null }, secondary: { usedPercent: 100, windowDurationMins: 120, resetsAt: null } } }
  }, { ...options, label: "<Work & personal>" });
  assert.match(html, /&lt;Work &amp; personal&gt;/);
  assert.match(html, /&lt;Codex &amp; Work&gt; · 기간 미제공/);
  assert.match(html, /사용 정보 없음 · 남음 <b>정보 없음<\/b>/);
  assert.match(html, /초기화: <code>정보 없음<\/code>/);
  assert.match(html, /사용 100% · 남음 <b>0%<\/b>/);
  assert.match(html, /2시간/);
  assert.doesNotMatch(html, /1970|NaN/);
  assert.match(formatAccountUsageHtml({ ...usage, rateLimitsByLimitId: null }, options), /Codex · 주간/);
  assert.match(formatAccountUsageHtml({ ...usage, rateLimits: null, rateLimitsByLimitId: {} }, options), /한도 정보가 제공되지 않았습니다/);
});

test("usage labels follow the account menu language", () => {
  for (const [language, expected] of [["ko", "주간"], ["en", "Weekly"], ["zh-tw", "每週"]]) {
    const html = formatAccountUsageHtml(usage, { ...options, text: (key) => accountText(language, key) });
    assert.ok(html.includes(expected));
    assert.doesNotMatch(html, /usage[A-Z]/);
  }
});

test("reset credits preserve the server count, render expiry in the selected timezone and omit opaque IDs", () => {
  const html = formatAccountUsageHtml(usage, options);
  assert.match(html, /🎟️ Reset 사용권/);
  assert.match(html, /사용 가능: <b>3<\/b>/);
  assert.match(html, /Full reset · 만료: <code>2026-09-21T00:11:29.000Z<\/code>/);
  assert.match(html, /표시된 사용권 상세: 1\/3/);
  assert.doesNotMatch(html, /OPAQUE_CREDIT_ID/);
  const localized = formatAccountUsageHtml(usage, {
    ...options,
    formatDateTime: (ms) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit" }).format(ms)
  });
  assert.match(localized, /만료: <code>09:11<\/code>/);
});

test("reset credits distinguish missing data, known zero and count-only responses", () => {
  for (const rateLimitResetCredits of [null, undefined]) {
    const html = formatAccountUsageHtml({ ...usage, rateLimitResetCredits }, options);
    assert.match(html, /Reset 사용권 정보가 제공되지 않았습니다/);
    assert.doesNotMatch(html, /사용 가능: <b>0/);
  }
  const empty = formatAccountUsageHtml({ ...usage, rateLimitResetCredits: { availableCount: 0, credits: [] } }, options);
  assert.match(empty, /사용 가능: <b>0<\/b>/);
  assert.doesNotMatch(empty, /사용권 정보가 제공되지|상세 정보는 제공되지/);
  const countOnly = formatAccountUsageHtml({ ...usage, rateLimitResetCredits: { availableCount: 3, credits: null } }, options);
  assert.match(countOnly, /사용 가능: <b>3<\/b>/);
  assert.match(countOnly, /사용권별 상세 정보는 제공되지/);
  const noCount = formatAccountUsageHtml({ ...usage, rateLimitResetCredits: { credits: [] } }, options);
  assert.match(noCount, /사용 가능: <b>정보 없음<\/b>/);
});

test("reset credit details escape titles and bound message size without changing the available count", () => {
  const credits = Array.from({ length: 30 }, () => ({ id: "HIDDEN_CREDIT_ID", title: "<Full & reset>".repeat(20), expiresAt: null }));
  const html = formatAccountUsageHtml({ ...usage, rateLimitResetCredits: { availableCount: 30, credits } }, options);
  assert.match(html, /사용 가능: <b>30<\/b>/);
  assert.match(html, /표시된 사용권 상세: 5\/30/);
  assert.match(html, /&lt;Full &amp; reset&gt;/);
  assert.equal((html.match(/만료: <code>정보 없음/g) || []).length, 5);
  assert.doesNotMatch(html, /HIDDEN_CREDIT_ID|1970|NaN/);
  assert.ok(html.length < 3500);
});
