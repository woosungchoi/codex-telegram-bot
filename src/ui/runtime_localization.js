import { VALID_LANGUAGES, textFor } from "../i18n.js";

export function createRuntimeLocalization({ state, config }) {
  function language() {
    return parseLanguage(state.ui?.language || config.telegramLanguage);
  }

  function timeZone() {
    return parseTimeZone(state.ui?.timeZone || config.telegramTimeZone);
  }

  function locale() {
    return parseLocale(state.ui?.locale || config.telegramLocale);
  }

  function text(key) {
    return textFor(language(), key);
  }

  function formatText(key, values = {}) {
    return interpolate(text(key), values);
  }

  function textForLanguage(value, key) {
    return textFor(parseLanguage(value), key);
  }

  function formatTextForLanguage(value, key, values = {}) {
    return interpolate(textForLanguage(value, key), values);
  }

  function cleanupCount(value) {
    return `${value}${text("cleanupCountSuffix")}`;
  }

  return {
    cleanupCount,
    formatText,
    formatTextForLanguage,
    language,
    locale,
    text,
    textForLanguage,
    timeZone
  };
}

export function parseLanguage(value) {
  const normalized = String(value || "en").trim().toLowerCase();
  return VALID_LANGUAGES.has(normalized) ? normalized : "en";
}

export function parseTimeZone(value) {
  const normalized = String(value || "UTC").trim() || "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: normalized }).format(new Date());
    return normalized;
  } catch {
    return "UTC";
  }
}

export function parseLocale(value) {
  const normalized = String(value || "en-US").trim() || "en-US";
  try {
    return Intl.getCanonicalLocales(normalized)[0] || "en-US";
  } catch {
    return "en-US";
  }
}

function interpolate(template, values) {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name) => (
    Object.hasOwn(values, name) ? String(values[name]) : match
  ));
}
