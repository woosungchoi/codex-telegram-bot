import { ensurePrivateDirectory } from "../fs/private.js";

export async function bootstrapBot({
  bot,
  config,
  ensureDirectory,
  registerTelegramCommands,
  startCleanupScheduler,
  startPersistedQueues,
  startStateSnapshotScheduler,
  startRecoveryScheduler = null,
  handleSignal = null,
  processRef = process,
  logger = console
}) {
  const stopForSignal = (signal) => {
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
  await bot.launch();
  logger.log("codex-telegram-bot started");
  startPersistedQueues();
}
