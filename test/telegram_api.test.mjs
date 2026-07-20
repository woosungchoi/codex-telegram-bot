import test from "node:test";
import assert from "node:assert/strict";
import {
  TELEGRAM_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS,
  createTelegramApiAgent,
  editOrReplyTelegramHtml,
  isTelegramMessageNotModified,
  isTelegramTransportError,
  replyTelegramHtml,
  runTelegramFinalDelivery,
  runTelegramProgressBestEffort,
  sanitizeTelegramErrorMessage,
  sendTelegramHtml,
  shouldFallbackTelegramHtml,
  shouldReplyAfterTelegramEditFailure,
  summarizeTelegramError
} from "../src/telegram/api.js";

function apiError(code, description, extras = {}) {
  return Object.assign(new Error(description), {
    ...extras,
    response: { error_code: code, description, ...(extras.response ?? {}) }
  });
}

function createContext({ reply, edit } = {}) {
  const replyCalls = [];
  const editCalls = [];
  return {
    replyCalls,
    editCalls,
    async reply(text, extra) {
      replyCalls.push({ text, extra });
      return reply ? reply(text, extra, replyCalls.length) : { message_id: replyCalls.length };
    },
    async editMessageText(text, extra) {
      editCalls.push({ text, extra });
      return edit ? edit(text, extra, editCalls.length) : { message_id: editCalls.length };
    }
  };
}

test("Telegram API Agent keeps Telegraf keep-alive semantics and extends family attempt timeout", () => {
  const agent = createTelegramApiAgent();
  assert.equal(TELEGRAM_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS, 1000);
  assert.equal(agent.options.keepAlive, true);
  assert.equal(agent.options.keepAliveMsecs, 10_000);
  assert.equal(agent.options.autoSelectFamilyAttemptTimeout, 1000);
  assert.equal(Object.hasOwn(agent.options, "family"), false);
  agent.destroy();
});

test("Telegram API Agent permits a deterministic timeout override without pinning an address family", () => {
  const agent = createTelegramApiAgent({ attemptTimeoutMs: 750 });
  assert.equal(agent.options.autoSelectFamilyAttemptTimeout, 750);
  assert.equal(agent.options.family, undefined);
  agent.destroy();
});

test("Telegram error summary preserves API and transport fields without response bodies", () => {
  const error = apiError(429, "Too Many Requests: retry later", {
    errno: "EAI_AGAIN",
    type: "system",
    response: { parameters: { retry_after: 7 } },
    requestBody: "final answer must not be copied"
  });
  assert.deepEqual(summarizeTelegramError(error), {
    kind: "transport",
    code: 429,
    errno: "EAI_AGAIN",
    type: "system",
    description: "Too Many Requests: retry later",
    retryAfter: 7,
    ambiguous: true
  });
});

test("Telegram token segments are redacted from URLs and standalone strings", () => {
  const fakeToken = "123456:TEST_TOKEN_ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const sanitized = sanitizeTelegramErrorMessage(
    `request to https://api.telegram.org/bot${fakeToken}/sendMessage failed; token=${fakeToken}`
  );
  assert.doesNotMatch(sanitized, /TEST_TOKEN/);
  assert.match(sanitized, /\/bot\[REDACTED\]\//);
  assert.match(sanitized, /\[REDACTED_TELEGRAM_TOKEN\]/);
});

test("transport errors are classified from errno, code, and nested causes", () => {
  for (const code of ["ETIMEDOUT", "ENETUNREACH", "ECONNRESET", "EAI_AGAIN", "ENOTFOUND"]) {
    assert.equal(isTelegramTransportError(Object.assign(new Error(code), { code })), true, code);
  }
  assert.equal(isTelegramTransportError({ cause: { code: "UND_ERR_CONNECT_TIMEOUT" } }), true);
  assert.equal(isTelegramTransportError(apiError(403, "Forbidden")), false);
});

test("HTML parse rejection falls back to plain text exactly once and preserves extras", async () => {
  const parseError = apiError(400, "Bad Request: can't parse entities");
  const ctx = createContext({
    reply: async (_text, _extra, call) => {
      if (call === 1) throw parseError;
      return { message_id: 2 };
    }
  });
  const result = await replyTelegramHtml(ctx, "<b>hello</b>", {
    reply_parameters: { message_id: 9 },
    message_thread_id: 7
  });
  assert.equal(result.message_id, 2);
  assert.equal(ctx.replyCalls.length, 2);
  assert.equal(ctx.replyCalls[0].extra.parse_mode, "HTML");
  assert.equal(ctx.replyCalls[1].text, "hello");
  assert.equal(Object.hasOwn(ctx.replyCalls[1].extra, "parse_mode"), false);
  assert.deepEqual(ctx.replyCalls[1].extra.reply_parameters, { message_id: 9 });
  assert.equal(ctx.replyCalls[1].extra.message_thread_id, 7);
});

test("network failure does not issue a second Telegram request", async () => {
  const timeout = Object.assign(new Error("request failed"), { code: "ETIMEDOUT" });
  const ctx = createContext({ reply: async () => { throw timeout; } });
  await assert.rejects(() => replyTelegramHtml(ctx, "<b>hello</b>"), /request failed/);
  assert.equal(ctx.replyCalls.length, 1);
});

test("generic 400, auth, and flood-control errors do not trigger HTML fallback", async () => {
  const errors = [
    apiError(400, "Bad Request: chat not found"),
    apiError(403, "Forbidden: bot was blocked by the user"),
    apiError(429, "Too Many Requests", { response: { parameters: { retry_after: 3 } } })
  ];
  for (const error of errors) {
    const ctx = createContext({ reply: async () => { throw error; } });
    await assert.rejects(() => replyTelegramHtml(ctx, "<b>hello</b>"));
    assert.equal(ctx.replyCalls.length, 1);
  }
  assert.equal(shouldFallbackTelegramHtml(errors[0]), false);
  assert.equal(summarizeTelegramError(errors[2]).retryAfter, 3);
});

test("message-not-modified edit is a successful no-op", async () => {
  const error = apiError(400, "Bad Request: message is not modified");
  const ctx = createContext({ edit: async () => { throw error; } });
  assert.equal(isTelegramMessageNotModified(error), true);
  assert.equal(await editOrReplyTelegramHtml(ctx, "<b>same</b>"), undefined);
  assert.equal(ctx.editCalls.length, 1);
  assert.equal(ctx.replyCalls.length, 0);
});

test("an unavailable edit target becomes one new HTML reply", async () => {
  const error = apiError(400, "Bad Request: message to edit not found");
  const ctx = createContext({ edit: async () => { throw error; } });
  assert.equal(shouldReplyAfterTelegramEditFailure(error), true);
  const result = await editOrReplyTelegramHtml(ctx, "<b>replacement</b>", { message_thread_id: 4 });
  assert.equal(result.message_id, 1);
  assert.equal(ctx.editCalls.length, 1);
  assert.equal(ctx.replyCalls.length, 1);
  assert.equal(ctx.replyCalls[0].extra.parse_mode, "HTML");
  assert.equal(ctx.replyCalls[0].extra.message_thread_id, 4);
});

test("an HTML parse edit retries as plain edit but a transport edit does not reply", async () => {
  const parseError = apiError(400, "Bad Request: unsupported start tag");
  const ctx = createContext({
    edit: async (_text, _extra, call) => {
      if (call === 1) throw parseError;
      return { message_id: 2 };
    }
  });
  await editOrReplyTelegramHtml(ctx, "<b>replacement</b>");
  assert.equal(ctx.editCalls.length, 2);
  assert.equal(ctx.editCalls[1].text, "replacement");
  assert.equal(Object.hasOwn(ctx.editCalls[1].extra, "parse_mode"), false);

  const timeout = Object.assign(new Error("socket timeout"), { code: "ETIMEDOUT" });
  const networkCtx = createContext({ edit: async () => { throw timeout; } });
  await assert.rejects(() => editOrReplyTelegramHtml(networkCtx, "<b>x</b>"), /socket timeout/);
  assert.equal(networkCtx.editCalls.length, 1);
  assert.equal(networkCtx.replyCalls.length, 0);
});

test("direct Telegram send uses the same parse-only fallback policy", async () => {
  const calls = [];
  const telegram = {
    async sendMessage(chatId, text, extra) {
      calls.push({ chatId, text, extra });
      if (calls.length === 1) throw apiError(400, "Bad Request: failed to parse entities");
      return { message_id: 2 };
    }
  };
  await sendTelegramHtml(telegram, 100, "<b>hello</b>", { message_thread_id: 8 });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].text, "hello");
  assert.equal(calls[1].extra.message_thread_id, 8);
});

test("progress best-effort contains both send and journal failures", async () => {
  const warnings = [];
  const result = await runTelegramProgressBestEffort(
    async () => { throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }); },
    {
      onError: async (summary) => {
        assert.equal(summary.code, "ETIMEDOUT");
        throw new Error("journal unavailable");
      },
      logger: { warn: (...args) => warnings.push(args) }
    }
  );
  assert.equal(result.ok, false);
  assert.equal(result.errorSummary.kind, "transport");
  assert.equal(warnings.length, 1);
});

test("progress failure at seq 4 does not stop later worker events", async () => {
  const processed = [];
  const journal = [];
  let workerStartCalls = 1;
  let workerCancelCalls = 0;
  let turnFailedCalls = 0;
  for (let seq = 1; seq <= 38; seq += 1) {
    processed.push(seq);
    if (seq !== 4) continue;
    try {
      const result = await runTelegramProgressBestEffort(
        async () => { throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }); },
        { onError: async (summary) => journal.push({ seq, summary }) }
      );
      assert.equal(result.ok, false);
    } catch {
      turnFailedCalls += 1;
      workerCancelCalls += 1;
      workerStartCalls += 1;
    }
  }
  assert.equal(processed.at(-1), 38);
  assert.deepEqual(journal.map((entry) => entry.seq), [4]);
  assert.equal(journal[0].summary.code, "ETIMEDOUT");
  assert.equal(turnFailedCalls, 0);
  assert.equal(workerCancelCalls, 0);
  assert.equal(workerStartCalls, 1);
});

test("final delivery runs state transitions around one successful Telegram send", async () => {
  const calls = [];
  const result = await runTelegramFinalDelivery({
    onReady: async () => calls.push("ready"),
    onStarted: async () => calls.push("started"),
    send: async () => { calls.push("send"); return { message_id: 10 }; },
    onCompleted: async () => calls.push("completed"),
    onFailed: async () => calls.push("failed")
  });
  assert.equal(result.ok, true);
  assert.equal(result.requestStarted, true);
  assert.deepEqual(calls, ["ready", "started", "send", "completed"]);
});

test("final delivery reports Telegram failure without rethrowing into Codex execution", async () => {
  const calls = [];
  const timeout = Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
  const result = await runTelegramFinalDelivery({
    onReady: async () => calls.push("ready"),
    onStarted: async () => calls.push("started"),
    send: async () => { calls.push("send"); throw timeout; },
    onCompleted: async () => calls.push("completed"),
    onFailed: async (_error, context) => calls.push(`failed:${context.requestStarted}`)
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, timeout);
  assert.equal(result.errorSummary.code, "ETIMEDOUT");
  assert.deepEqual(calls, ["ready", "started", "send", "failed:true"]);
});

test("final delivery never sends when ready state fails and contains failure-recording errors", async () => {
  const readyError = new Error("state unavailable");
  const recordError = new Error("journal unavailable");
  let sendCalls = 0;
  const result = await runTelegramFinalDelivery({
    onReady: async () => { throw readyError; },
    send: async () => { sendCalls += 1; },
    onFailed: async (_error, context) => {
      assert.equal(context.requestStarted, false);
      throw recordError;
    }
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, readyError);
  assert.equal(result.recordError, recordError);
  assert.equal(result.requestStarted, false);
  assert.equal(sendCalls, 0);
});
