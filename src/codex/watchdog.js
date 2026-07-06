export const STREAM_IDLE_TIMEOUT_MESSAGE = "stream_idle_timeout";

export function isStreamIdleTimeout(error) {
  return error instanceof Error && error.message === STREAM_IDLE_TIMEOUT_MESSAGE;
}

export function createCodexStreamWatchdog({
  noticeMs,
  abortMs,
  intervalMs = 10_000,
  now = () => Date.now(),
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  onNotice = async () => {},
  onTimeout = async () => {},
  abort = () => {}
} = {}) {
  let timer = null;
  let lastEventAt = now();
  let noticeSent = false;
  let timeoutTriggered = false;

  async function check() {
    const idleMs = now() - lastEventAt;
    if (!noticeSent && Number(noticeMs) > 0 && idleMs >= noticeMs) {
      noticeSent = true;
      await onNotice({ idleMs });
    }
    if (!timeoutTriggered && Number(abortMs) > 0 && idleMs >= abortMs) {
      timeoutTriggered = true;
      await onTimeout({ idleMs });
      abort(new Error(STREAM_IDLE_TIMEOUT_MESSAGE));
    }
  }

  return {
    touch() {
      lastEventAt = now();
    },
    start() {
      if (timer || (Number(noticeMs) <= 0 && Number(abortMs) <= 0)) return;
      timer = setIntervalFn(() => {
        check().catch(() => {});
      }, Math.max(100, Number(intervalMs) || 10_000));
    },
    stop() {
      if (!timer) return;
      clearIntervalFn(timer);
      timer = null;
    },
    async checkNow() {
      await check();
    },
    get timeoutTriggered() {
      return timeoutTriggered;
    }
  };
}
