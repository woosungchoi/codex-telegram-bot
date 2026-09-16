import { findText } from "../i18n.js";

// Compatibility facade; every language and message is defined in locales/*.json.
export function accountText(language, key) {
  return findText(language, `accounts.${key}`) || key;
}
