export function createRuntimeRedactor(config) {
  function redactText(value) {
    let text = String(value);
    if (config.telegramBotToken) {
      text = text.replaceAll(config.telegramBotToken, "[REDACTED_TELEGRAM_TOKEN]");
    }
    if (config.codexApiKey) {
      text = text.replaceAll(config.codexApiKey, "[REDACTED_CODEX_API_KEY]");
    }
    text = text.replace(
      /\b\d{7,}:[A-Za-z0-9_-]{20,}\b/g,
      "[REDACTED_TELEGRAM_TOKEN]"
    );
    return text.replace(
      /\b(?:sk|sess|proj)-[A-Za-z0-9_-]{20,}\b/g,
      "[REDACTED_SECRET]"
    );
  }

  function redactValue(value) {
    return JSON.parse(redactText(JSON.stringify(value)));
  }

  return { redactText, redactValue };
}
