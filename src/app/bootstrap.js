import { ensurePrivateDirectory } from "../fs/private.js";
import { observeTelegramPolling } from "../telegram/polling_health.js";

export async function bootstrapBot({
  bot,
  config,
  ensureDirectory,
  registerTelegramCommands,
  startCleanupScheduler,
  startPersistedQueues,
  startStateSnapshotScheduler,
  startRecoveryScheduler = null,
  startWorkspaceServices = null,
  handleSignal = null,
  processRef = process,
  logger = console
}) {
  const polling = observeTelegramPolling(bot, config, { logger });
  let stopping = false;
  let launched = false;
  let cancelQueueStartup = () => {};
  const stopForSignal = (signal) => {
    stopping = true;
    cancelQueueStartup();
    void polling.stop();
    if (handleSignal) {
      Promise.resolve(handleSignal(signal)).catch((error) => {
        logger.warn("Signal handler failed:", error instanceof Error ? error.message : String(error));
        bot.stop(signal);
      });
      return;
    }
    bot.stop(signal);
  };
  processRef.once("SIGINT", () => stopForSignal("SIGINT"));
  processRef.once("SIGTERM", () => stopForSignal("SIGTERM"));
  processRef.once("SIGUSR2", () => stopForSignal("SIGUSR2"));

  await ensureDirectory(config.codexWorkdir, "CODEX_WORKDIR");
  await ensurePrivateDirectory(config.uploadDir);
  await ensurePrivateDirectory(config.cleanupQuarantineDir);
  await ensurePrivateDirectory(config.backupDir);
  if (config.botRecoveryDir) await ensurePrivateDirectory(config.botRecoveryDir);
  startCleanupScheduler();
  startStateSnapshotScheduler();
  registerTelegramCommands().catch((error) => {
    logger.warn("Telegram command menu registration failed:", error instanceof Error ? error.message : String(error));
  });
  if (startRecoveryScheduler) await startRecoveryScheduler();
  if (startWorkspaceServices) startWorkspaceServices();
  try {
    // Telegraf's launch promise lives for the whole polling loop. Its callback
    // runs after getMe, when the API identity is ready for queued work.
    await bot.launch(() => {
      if (stopping || launched) return;
      launched = true;
      logger.log("codex-telegram-bot started");
      const cancel = startPersistedQueues();
      if (typeof cancel === "function") cancelQueueStartup = cancel;
    });
  } finally {
    await polling.stop();
    polling.close();
    stopping = true;
    cancelQueueStartup();
  }
}
