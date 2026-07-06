import test from "node:test";
import assert from "node:assert/strict";
import {
  createCodexStreamWatchdog,
  isStreamIdleTimeout,
  STREAM_IDLE_TIMEOUT_MESSAGE
} from "../src/codex/watchdog.js";

test("codex stream watchdog sends one idle notice before hard timeout", async () => {
  let current = 0;
  const notices = [];
  const timeouts = [];
  const aborts = [];
  const watchdog = createCodexStreamWatchdog({
    noticeMs: 100,
    abortMs: 300,
    now: () => current,
    onNotice: (event) => notices.push(event),
    onTimeout: (event) => timeouts.push(event),
    abort: (error) => aborts.push(error)
  });

  current = 150;
  await watchdog.checkNow();
  current = 250;
  await watchdog.checkNow();
  current = 350;
  await watchdog.checkNow();

  assert.deepEqual(notices, [{ idleMs: 150 }]);
  assert.deepEqual(timeouts, [{ idleMs: 350 }]);
  assert.equal(aborts.length, 1);
  assert.equal(aborts[0].message, STREAM_IDLE_TIMEOUT_MESSAGE);
  assert.equal(watchdog.timeoutTriggered, true);
});

test("codex stream watchdog touch resets idle accounting", async () => {
  let current = 0;
  const notices = [];
  const watchdog = createCodexStreamWatchdog({
    noticeMs: 100,
    abortMs: 0,
    now: () => current,
    onNotice: (event) => notices.push(event)
  });

  current = 90;
  watchdog.touch();
  current = 150;
  await watchdog.checkNow();
  assert.deepEqual(notices, []);
  current = 200;
  await watchdog.checkNow();
  assert.deepEqual(notices, [{ idleMs: 110 }]);
});

test("codex stream watchdog timer cleanup clears the active interval", () => {
  let cleared = false;
  const watchdog = createCodexStreamWatchdog({
    noticeMs: 100,
    abortMs: 0,
    setIntervalFn: () => "timer",
    clearIntervalFn: (timer) => {
      cleared = timer === "timer";
    }
  });

  watchdog.start();
  watchdog.stop();
  assert.equal(cleared, true);
});

test("isStreamIdleTimeout identifies watchdog timeout errors", () => {
  assert.equal(isStreamIdleTimeout(new Error(STREAM_IDLE_TIMEOUT_MESSAGE)), true);
  assert.equal(isStreamIdleTimeout(new Error("user_stop")), false);
});
