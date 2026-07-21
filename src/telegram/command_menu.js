import { TELEGRAM_LANGUAGE_CODES, textFor } from "../i18n.js";

export function createTelegramCommandMenu({ bot, language, timing, summarizeError }) {
  async function registerTelegramCommands() {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const commands = telegramCommands(language());
        await timing.withTimeout(Promise.all([
          bot.telegram.setMyCommands(commands),
          ...TELEGRAM_LANGUAGE_CODES.map((languageCode) => (
            bot.telegram.setMyCommands(commands, { language_code: languageCode })
          ))
        ]), 5000, "setMyCommands timed out");
        if (attempt > 1) {
          console.log(`Telegram command menu registered after retry (${attempt}/3).`);
        }
        return;
      } catch (error) {
        console.warn(
          `Telegram command menu registration failed (${attempt}/3):`,
          summarizeError(error)
        );
        if (attempt < 3) await timing.sleep(attempt * 1500);
      }
    }
  }

  return { registerTelegramCommands };
}

export function telegramCommands(language = "en") {
  const text = (key) => textFor(language, key);
  return [
    { command: "menu", description: text("commandMenu") },
    { command: "new", description: text("commandNew") },
    { command: "resume", description: text("commandResume") },
    { command: "status", description: text("commandStatus") },
    { command: "queue", description: text("commandQueue") },
    { command: "settings", description: text("commandSettings") },
    { command: "tools", description: text("commandTools") },
    { command: "skills", description: text("commandSkills") },
    { command: "stop", description: text("commandStop") },
    { command: "help", description: text("commandHelp") }
  ];
}
