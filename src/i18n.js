import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_LANGUAGE = "en";
const localeDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "locales");

function loadLocales() {
  const entries = {};
  const files = readdirSync(localeDir).filter((file) => file.endsWith(".json")).sort();
  for (const file of files) {
    const code = path.basename(file, ".json").toLowerCase();
    const payload = JSON.parse(readFileSync(path.join(localeDir, file), "utf8"));
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error(`Locale ${file} must contain a JSON object.`);
    }
    const meta = normalizeLocaleMeta(code, payload._meta);
    entries[code] = Object.freeze({ ...payload, _meta: meta });
  }
  if (!entries[DEFAULT_LANGUAGE]) throw new Error(`Missing required ${DEFAULT_LANGUAGE}.json locale.`);
  return Object.freeze(entries);
}

function normalizeLocaleMeta(code, meta = {}) {
  const telegramLanguageCode = typeof meta.telegramLanguageCode === "string" && meta.telegramLanguageCode.trim()
    ? meta.telegramLanguageCode.trim().toLowerCase()
    : code.split("-", 1)[0];
  return Object.freeze({
    code,
    emoji: typeof meta.emoji === "string" && meta.emoji.trim() ? meta.emoji.trim() : "🌐",
    nativeName: typeof meta.nativeName === "string" && meta.nativeName.trim() ? meta.nativeName.trim() : code,
    englishName: typeof meta.englishName === "string" && meta.englishName.trim() ? meta.englishName.trim() : code,
    telegramLanguageCode
  });
}

export const UI_TEXT = loadLocales();
export const SUPPORTED_LANGUAGES = Object.freeze(Object.keys(UI_TEXT));
export const VALID_LANGUAGES = new Set(SUPPORTED_LANGUAGES);
export const LANGUAGE_CHOICES = Object.freeze(
  SUPPORTED_LANGUAGES.map((code) => UI_TEXT[code]._meta)
);
export const TELEGRAM_LANGUAGE_CODES = Object.freeze(
  [...new Set(LANGUAGE_CHOICES.map(({ telegramLanguageCode }) => telegramLanguageCode).filter(Boolean))]
);

export function findText(language, key) {
  return UI_TEXT[language]?.[key] ?? UI_TEXT[DEFAULT_LANGUAGE]?.[key];
}

export function textFor(language, key) {
  return findText(language, key) ?? key;
}

// Keep the lookup callable so changing the UI language also updates existing
// controllers. Values may already contain escaped Telegram HTML; interpolate
// them once, without translating or interpreting their contents.
export function createMessageFormatter(text = (key) => textFor("en", key)) {
  return (key, values = {}) => interpolateMessage(text(key), values);
}

export function interpolateMessage(template, values = {}) {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name) => (
    Object.hasOwn(values, name) ? String(values[name]) : match
  ));
}

// Keep diagnostic Error.message stable for logs, classifiers and callers. Only
// the Telegram presentation boundary selects the user's language.
export class LocalizedError extends Error {
  constructor(key, values = {}) {
    super(interpolateMessage(textFor("en", key), values));
    this.localeKey = key;
    this.localeValues = values;
  }
}

export function errorText(error, languageOrText = "en") {
  if (Object.hasOwn(UI_TEXT.en, error?.localeKey)) {
    const text = typeof languageOrText === "function"
      ? languageOrText
      : (key) => textFor(languageOrText, key);
    return createMessageFormatter(text)(error.localeKey, error.localeValues);
  }
  return error instanceof Error ? error.message : String(error);
}

// Worker events and request frames carry optional translation metadata while
// retaining their original diagnostic message for older peers and stored jobs.
export function localizedErrorDetails(error) {
  return Object.hasOwn(UI_TEXT.en, error?.localeKey)
    ? { localeKey: error.localeKey, localeValues: error.localeValues || {} }
    : {};
}

export function restoreLocalizedError(details, fallbackKey, values = {}) {
  if (Object.hasOwn(UI_TEXT.en, details?.localeKey)) {
    return new LocalizedError(details.localeKey, details.localeValues);
  }
  return details?.message ? new Error(details.message) : new LocalizedError(fallbackKey, values);
}
