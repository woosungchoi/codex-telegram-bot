import path from "node:path";
import { parseNonnegativeInteger, parseOptionalBoolean } from "./parsers.js";

export function readRecoveryConfig(env, paths) {
  return {
    botRestartRecoveryEnabled: parseOptionalBoolean(env.BOT_RESTART_RECOVERY_ENABLED) ?? true,
    botRestartExitCode: parseNonnegativeInteger(env.BOT_RESTART_EXIT_CODE, 75, "BOT_RESTART_EXIT_CODE"),
    botRestartDrainTimeoutSeconds: parseNonnegativeInteger(
      env.BOT_RESTART_DRAIN_TIMEOUT_SECONDS,
      900,
      "BOT_RESTART_DRAIN_TIMEOUT_SECONDS"
    ),
    botRestartDelaySeconds: parseNonnegativeInteger(
      env.BOT_RESTART_DELAY_SECONDS,
      3,
      "BOT_RESTART_DELAY_SECONDS"
    ),
    botRecoveryDir: env.BOT_RECOVERY_DIR?.trim() || path.join(paths.stateRoot, "recovery"),
    botRecoveryStaleSeconds: parseNonnegativeInteger(
      env.BOT_RECOVERY_STALE_SECONDS,
      21600,
      "BOT_RECOVERY_STALE_SECONDS"
    ),
    botRecoveryTurnTtlSeconds: parseNonnegativeInteger(
      env.BOT_RECOVERY_TURN_TTL_SECONDS,
      86400,
      "BOT_RECOVERY_TURN_TTL_SECONDS"
    ),
    botRecoverySuspendAfter: parseNonnegativeInteger(
      env.BOT_RECOVERY_SUSPEND_AFTER,
      3,
      "BOT_RECOVERY_SUSPEND_AFTER"
    ),
    botRecoveryBackfillPollMs: parseNonnegativeInteger(
      env.BOT_RECOVERY_BACKFILL_POLL_MS,
      30_000,
      "BOT_RECOVERY_BACKFILL_POLL_MS"
    ),
    codexStreamIdleNoticeMs: parseNonnegativeInteger(
      env.CODEX_STREAM_IDLE_NOTICE_MS,
      120_000,
      "CODEX_STREAM_IDLE_NOTICE_MS"
    ),
    codexStreamIdleAbortMs: parseNonnegativeInteger(
      env.CODEX_STREAM_IDLE_ABORT_MS,
      900_000,
      "CODEX_STREAM_IDLE_ABORT_MS"
    )
  };
}
