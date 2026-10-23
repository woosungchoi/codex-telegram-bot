import test from "node:test";
import assert from "node:assert/strict";
import { handleRestartCommandCore, restartCommandRequestFromContext } from "../src/restart_command.js";
import { telegramReplyExtraFromMeta } from "../src/telegram/context.js";

function restartCtx(overrides = {}) {
  return {
    botInfo: { id: 123 },
    chat: { id: overrides.chatId ?? 100, type: overrides.chatType ?? "private" },
    from: { id: overrides.fromId ?? 200 },
    message: {
      text: overrides.text ?? "/restart",
      message_id: overrides.messageId ?? 10,
      message_thread_id: overrides.messageThreadId,
      reply_to_message: overrides.replyToMessageId == null ? undefined : { message_id: overrides.replyToMessageId }
    },
    update: { update_id: overrides.updateId ?? 99 }
  };
}

function coreFixture(overrides = {}) {
  const calls = [];
  const marker = overrides.marker ?? {
    restartId: "rst_test",
    recoveries: overrides.recoveries ?? [],
    exitCode: 75
  };
  return {
    calls,
    deps: {
      recoveryEnabled: overrides.recoveryEnabled ?? true,
      recoveryDisabledText: () => "disabled",
      isDuplicate: async (ctx) => {
        calls.push(["duplicate", ctx.update?.update_id]);
        return overrides.duplicate ?? false;
      },
      requestRestart: async (request) => {
        calls.push(["restart", request]);
        return marker;
      },
      rememberUpdate: async (updateId) => calls.push(["remember", updateId]),
      reply: async (_ctx, html) => calls.push(["reply", html]),
      formatScheduled: (scheduledMarker) => `scheduled:${scheduledMarker.restartId}:${scheduledMarker.recoveries.length}`
    }
  };
}

test("/restart with no active turns schedules a restart and replies", async () => {
  const ctx = restartCtx({ text: "/restart", chatId: 100, fromId: 200, updateId: 123 });
  const fixture = coreFixture({ recoveries: [] });
  const result = await handleRestartCommandCore(ctx, fixture.deps);

  assert.equal(result.status, "scheduled");
  assert.deepEqual(fixture.calls, [
    ["duplicate", 123],
    ["restart", {
      mode: "restart",
      requestedBy: "200",
      reason: "self_restart",
      notify: {
        authorizationVersion: 1, botId: "123", requesterUserId: "200", accountId: "default", isForum: false,
        chatId: 100,
        chatType: "private",
        messageThreadId: undefined,
        replyToMessageId: undefined,
        originMessageId: 10,
        originUpdateId: 123
      }
    }],
    ["remember", 123],
    ["reply", "scheduled:rst_test:0"]
  ]);
});

test("/restart while pending queue exists does not consume queued turns", async () => {
  const pendingQueue = [{ id: "queued-user-turn", kind: "user" }];
  const fixture = coreFixture({ recoveries: [] });
  const result = await handleRestartCommandCore(restartCtx({ updateId: 124 }), fixture.deps);

  assert.equal(result.status, "scheduled");
  assert.deepEqual(pendingQueue, [{ id: "queued-user-turn", kind: "user" }]);
  assert.equal(fixture.calls.some((call) => call[0] === "restart"), true);
});

test("/restart in a Telegram topic preserves topic notify routing", async () => {
  const ctx = restartCtx({
    text: "/restart_continue",
    chatId: -100123,
    chatType: "supergroup",
    fromId: 200,
    messageId: 55,
    messageThreadId: 777,
    replyToMessageId: 54,
    updateId: 125
  });
  const request = restartCommandRequestFromContext(ctx);

  assert.deepEqual(request, {
    mode: "restart_continue",
    requestedBy: "200",
    reason: "self_restart",
    notify: {
      authorizationVersion: 1, botId: "123", requesterUserId: "200", accountId: "default", isForum: false,
      chatId: -100123,
      chatType: "supergroup",
      messageThreadId: 777,
      replyToMessageId: 54,
      originMessageId: 55,
      originUpdateId: 125
    }
  });
  assert.deepEqual(telegramReplyExtraFromMeta(request.notify), {
    message_thread_id: 777,
    reply_parameters: { message_id: 54 }
  });
});

test("duplicate /restart update is ignored before scheduling", async () => {
  const fixture = coreFixture({ duplicate: true });
  const result = await handleRestartCommandCore(restartCtx({ updateId: 126 }), fixture.deps);

  assert.equal(result.status, "duplicate");
  assert.deepEqual(fixture.calls, [["duplicate", 126]]);
});
