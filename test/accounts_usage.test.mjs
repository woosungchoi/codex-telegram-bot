import test from "node:test";
import assert from "node:assert/strict";
import { readAccountUsage, formatAccountUsageHtml } from "../src/accounts/usage.js";
import { accountText } from "../src/accounts/messages.js";
import { accountHome } from "../src/accounts/store.js";
import { accountFixture } from "./helpers/accounts_fixture.mjs";

const weekly = { usedPercent: 52, windowDurationMins: 10080, resetsAt: 1789435487 };
const main = { limitId: "codex", primary: weekly, secondary: null };
const usage = {
  account: { type: "chatgpt", email: "person@example.com", planType: "pro" },
  rateLimits: main,
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
