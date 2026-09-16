# Translation Guide

The Telegram UI text lives in `src/locales/*.json`.
Account, workspace and forum messages use the `accounts.*`, `workspace.*` and
`forum.*` prefixes in these same files. Their message helpers do not contain
separate translation catalogs.

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
- The validator checks string values, nonempty translations and named
  placeholders such as `{count}` against the English catalog.

`src/i18n.js` automatically loads every locale file. The language picker and
Telegram command-menu descriptions update from those files.

## Changing user-facing text

Add fixed Telegram text to the English catalog first, then supply the same keys
and named placeholders in **every** supported locale in the same PR. This
includes panel titles and rows, inline buttons, progress messages, usage and
skills views, validation errors, time zone labels, and default response-language
instructions. Do not leave English literals at call sites or rely on English
fallback to make an incomplete catalog pass review.

Use `createMessageFormatter(text)` for named interpolation. Inject a lookup
function that reads the current language when called; a controller must not
capture the language at construction time. Interpolation is one pass, so braces
inside user values remain literal. It does not escape HTML: escape untrusted
values with `escapeHtml` or `code` before inserting them into an HTML message.

Use `LocalizedError(key, values)` for application validation messages and
`errorText(error, text)` at presentation boundaries. Diagnostic `Error.message`
remains English for logs and error classification. Worker events and request
frames retain optional locale metadata, allowing the receiving UI to choose its
current language. Preserve error messages originating from third-party services.

Command syntax, callback data, stored enum values, environment variable names,
file paths, model identifiers, external output, and user-authored content are
not translation targets. Translate the surrounding labels and explanations.
Brand names and technical identifiers can intentionally match across locales.
Default persona and formatting instructions belong in `prompt.*`; internal
execution and recovery prompts are not Telegram UI copy.

Run `npm run verify` before updating a PR. It includes:

- `validate:locales`: identical key sets, nonempty strings and matching placeholders.
- `check:ui-localization`: AST checks for unknown static translation keys and
  fixed text at common Telegram presentation boundaries, including button labels.
- Integration tests for all supported languages, message editing, stable
  callbacks, HTML escaping, live language changes, and worker error replay.

The source check is a guard, not a complete translation review. Review dynamically
constructed messages and test their rendering whenever adding a new UI flow.
Avoid separate hard-coded language lists; derive supported languages from the
catalog so a new locale works throughout the app.
