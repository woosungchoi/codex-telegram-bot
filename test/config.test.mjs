import test from "node:test";
import assert from "node:assert/strict";
import { readConfig } from "../src/config.js";

const requiredEnv = {
  HOME: "/home/tester",
  TELEGRAM_BOT_TOKEN: "123456789:telegram-token",
  ALLOWED_USER_IDS: "42"
};

function readTestConfig(env = {}) {
  return readConfig(
    { ...requiredEnv, ...env },
    {
      appRoot: "/app",
      cwd: "/cwd"
    }
  );
}

test("readConfig applies stable defaults from env and options", () => {
  const config = readTestConfig();
  assert.equal(config.codexWorkdir, "/home/tester");
  assert.equal(config.codexHome, "/home/tester/.codex");
  assert.equal(config.codexSessionsDir, "/home/tester/.codex/sessions");
  assert.equal(config.stateFile, "/app/state/threads.json");
  assert.equal(config.telegramFormatCodexAnswers, "markdown");
  assert.equal(config.telegramPendingTurnsMax, 10);
  assert.equal(config.telegramPendingTurnMaxAgeSeconds, 7200);
  assert.equal(config.codexSkipGitRepoCheck, false);
  assert.equal(config.botRestartRecoveryEnabled, true);
  assert.equal(config.botRestartExitCode, 75);
  assert.equal(config.botRestartDrainTimeoutSeconds, 900);
  assert.equal(config.botRestartDelaySeconds, 3);
  assert.equal(config.botRecoveryDir, "/app/state/recovery");
  assert.equal(config.botRecoveryStaleSeconds, 21600);
  assert.equal(config.botRecoveryTurnTtlSeconds, 86400);
  assert.equal(config.botRecoverySuspendAfter, 3);
  assert.equal(config.codexStreamIdleNoticeMs, 120_000);
  assert.equal(config.codexStreamIdleAbortMs, 900_000);
  assert.equal(config.uploadRetentionDays, 7);
  assert.equal(config.uploadMaxBytes, 1_073_741_824);
  assert.equal(config.uploadCleanupEnabled, true);
  assert.deepEqual([...config.allowedUserIds], ["42"]);
});

test("readConfig parses restart recovery env values", () => {
  const config = readTestConfig({
    BOT_RESTART_RECOVERY_ENABLED: "off",
    BOT_RESTART_EXIT_CODE: "42",
    BOT_RESTART_DRAIN_TIMEOUT_SECONDS: "30",
    BOT_RESTART_DELAY_SECONDS: "1",
    BOT_RECOVERY_DIR: "/tmp/recovery",
    BOT_RECOVERY_STALE_SECONDS: "120",
    BOT_RECOVERY_TURN_TTL_SECONDS: "240",
    BOT_RECOVERY_SUSPEND_AFTER: "2",
    CODEX_STREAM_IDLE_NOTICE_MS: "1000",
    CODEX_STREAM_IDLE_ABORT_MS: "2000"
  });
  assert.equal(config.botRestartRecoveryEnabled, false);
  assert.equal(config.botRestartExitCode, 42);
  assert.equal(config.botRestartDrainTimeoutSeconds, 30);
  assert.equal(config.botRestartDelaySeconds, 1);
  assert.equal(config.botRecoveryDir, "/tmp/recovery");
  assert.equal(config.botRecoveryStaleSeconds, 120);
  assert.equal(config.botRecoveryTurnTtlSeconds, 240);
  assert.equal(config.botRecoverySuspendAfter, 2);
  assert.equal(config.codexStreamIdleNoticeMs, 1000);
  assert.equal(config.codexStreamIdleAbortMs, 2000);
});

test("readConfig parses optional allowed chat and thread ids", () => {
  const config = readTestConfig({
    ALLOWED_CHAT_IDS: "100, -200",
    ALLOWED_THREAD_IDS: "300"
  });
  assert.deepEqual([...config.allowedChatIds], ["100", "-200"]);
  assert.deepEqual([...config.allowedThreadIds], ["300"]);
});

test("readConfig rejects non-numeric Telegram allowlist ids", () => {
  assert.throws(
    () => readTestConfig({ ALLOWED_USER_IDS: "42, abc" }),
    /ALLOWED_USER_IDS must contain numeric Telegram ids/
  );
  assert.throws(
    () => readTestConfig({ ALLOWED_CHAT_IDS: "100, chat" }),
    /ALLOWED_CHAT_IDS must contain numeric Telegram ids/
  );
  assert.throws(
    () => readTestConfig({ ALLOWED_THREAD_IDS: "-10" }),
    /ALLOWED_THREAD_IDS must contain numeric Telegram ids/
  );
});

test("readConfig validates cleanup notify chat ids like Telegram chat ids", () => {
  const config = readTestConfig({ CLEANUP_NOTIFY_CHAT_IDS: "-1001234567890, 42" });
  assert.deepEqual(config.cleanupNotifyChatIds, ["-1001234567890", "42"]);
  assert.throws(
    () => readTestConfig({ CLEANUP_NOTIFY_CHAT_IDS: "not-chat" }),
    /CLEANUP_NOTIFY_CHAT_IDS must contain numeric Telegram ids/
  );
});

test("readConfig rejects invalid integer env values", () => {
  assert.throws(
    () => readTestConfig({ MAX_TELEGRAM_CHARS: "not-a-number" }),
    /MAX_TELEGRAM_CHARS must be a non-negative integer/
  );
});

test("readConfig rejects negative integer env values", () => {
  assert.throws(
    () => readTestConfig({ CLEANUP_RETENTION_DAYS: "-1" }),
    /CLEANUP_RETENTION_DAYS must be a non-negative integer/
  );
});

test("readConfig rejects invalid enum env values", () => {
  assert.throws(
    () => readTestConfig({ TELEGRAM_FORMAT_CODEX_ANSWERS: "rich" }),
    /TELEGRAM_FORMAT_CODEX_ANSWERS must be off, safe, or markdown/
  );
  assert.throws(
    () => readTestConfig({ CODEX_COMPACT_STRENGTH: "maximum" }),
    /CODEX_COMPACT_STRENGTH must be default, light, balanced, or aggressive/
  );
});

test("readConfig parses Codex compact and context guard env values", () => {
  const config = readTestConfig({
    CODEX_MODEL_CONTEXT_WINDOW: "258400",
    CODEX_AUTO_COMPACT_TOKEN_LIMIT: "190000",
    CODEX_TOOL_OUTPUT_TOKEN_LIMIT: "12000",
    CODEX_COMPACT_STRENGTH: "aggressive",
    CODEX_COMPACT_PROMPT_FILE: "/tmp/compact.txt",
    CODEX_CONTEXT_GUARD_ENABLED: "false",
    CODEX_CONTEXT_COMPACT_THRESHOLD_PERCENT: "80",
    CODEX_CONTEXT_MIN_REMAINING_TOKENS: "50000"
  });
  assert.equal(config.codexModelContextWindow, 258400);
  assert.equal(config.codexAutoCompactTokenLimit, 190000);
  assert.equal(config.codexToolOutputTokenLimit, 12000);
  assert.equal(config.codexCompactStrength, "aggressive");
  assert.equal(config.codexCompactPromptFile, "/tmp/compact.txt");
  assert.equal(config.codexContextGuardEnabled, false);
  assert.equal(config.codexContextCompactThresholdPercent, 80);
  assert.equal(config.codexContextMinRemainingTokens, 50000);
});

test("readConfig rejects context compact percentages above 100", () => {
  assert.throws(
    () => readTestConfig({ CODEX_CONTEXT_COMPACT_THRESHOLD_PERCENT: "101" }),
    /CODEX_CONTEXT_COMPACT_THRESHOLD_PERCENT must be between 0 and 100/
  );
});
