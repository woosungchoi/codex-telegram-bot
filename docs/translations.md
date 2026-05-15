# Translation Guide

The Telegram UI text lives in `src/locales/*.json`.

To add a language:

1. Copy `src/locales/en.json` to a new lowercase language file, for example `ja.json`, `es.json`, or `pt-br.json`.
2. Update `_meta`.
3. Translate every key except `_meta`.
4. Run `npm run validate:locales`.
5. Open a PR with only the locale file and any README note you need.

Example `_meta`:

```json
{
  "_meta": {
    "code": "ja",
    "emoji": "🇯🇵",
    "nativeName": "日本語",
    "englishName": "Japanese",
    "telegramLanguageCode": "ja"
  }
}
```

Rules:

- The filename and `_meta.code` must match.
- Use lowercase filenames, such as `fr.json` or `pt-br.json`.
- `telegramLanguageCode` is optional. When present, use Telegram's short lowercase language code such as `fr`, `ja`, or `pt`.
- Do not add or remove translation keys unless you are also changing the app UI.
- Leave command names unchanged. Only translate descriptions and labels.
- Keep placeholders, command names, paths, and environment variable names exact.

`src/i18n.js` automatically loads every locale file. The language picker and
Telegram command-menu descriptions update from those files.
