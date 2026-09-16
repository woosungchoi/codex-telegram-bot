import fs from "node:fs/promises";
import { validateLocaleMessages } from "../src/i18n/validation.js";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const localeDir = path.join(appRoot, "src", "locales");
const requiredMetaKeys = ["code", "emoji", "nativeName", "englishName"];

const files = (await fs.readdir(localeDir)).filter((file) => file.endsWith(".json")).sort();
if (!files.includes("en.json")) fail("src/locales/en.json is required.");

const locales = new Map();
for (const file of files) {
  const code = path.basename(file, ".json");
  if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/.test(code)) {
    fail(`${file}: filename must be a lowercase language code such as en, ko, ja, or pt-br.`);
  }
  const payload = JSON.parse(await fs.readFile(path.join(localeDir, file), "utf8"));
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) fail(`${file}: root must be a JSON object.`);
  if (!payload._meta || typeof payload._meta !== "object" || Array.isArray(payload._meta)) fail(`${file}: missing _meta object.`);
  for (const key of requiredMetaKeys) {
    if (typeof payload._meta[key] !== "string" || !payload._meta[key].trim()) fail(`${file}: _meta.${key} is required.`);
  }
  if (payload._meta.code !== code) fail(`${file}: _meta.code must match the filename (${code}).`);
  if (payload._meta.telegramLanguageCode && !/^[a-z]{2,3}$/.test(payload._meta.telegramLanguageCode)) {
    fail(`${file}: _meta.telegramLanguageCode must be a short lowercase Telegram language code.`);
  }
  locales.set(code, payload);
}

for (const [code, payload] of locales) {
  validateLocaleMessages(locales.get("en"), payload, `${code}.json`);
}

console.log(`Validated ${files.length} locale files.`);

function fail(message) {
  console.error(message);
  process.exit(1);
}
