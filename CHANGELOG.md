# Changelog

All notable public changes are documented here.

## Unreleased

- Added authless deterministic CI diagnosis for failed GitHub Actions runs, including failed job/step summaries, log-tail pattern classification, safe redaction, PR comments, and diagnosis artifacts.
- Kept Codex AI CI diagnosis optional: `CODEX_ACCESS_TOKEN` only gates the AI add-on, while basic CI diagnosis continues without Codex auth.
- Added an `actionlint` CI step for GitHub Actions workflow syntax/script checks.

## 1.0.8 - 2026-06-03

- Tightened local and CI verification with `npm run verify`, zero ESLint
  warnings, package dry-run checks, and a Node 18/20/22 CI matrix.
- Extracted runtime bootstrap, Codex input/stream helpers, UI builders, handoff
  rendering, maintenance parsing, and cleanup artifact handling into focused
  modules with tests.
- Added strict numeric Telegram id validation for user, chat, thread, and
  cleanup notification allowlists.
- Changed upload cleanup to a preview-plan-confirm flow. `/cleanup_uploads`
  creates a stored plan and files are deleted only from the inline confirm
  button; the legacy typed confirm command now gives guidance without deleting.
- Documented the current format-check scope and rechecked GitHub MIT license
  metadata.

## 1.0.7 - 2026-06-03

- Added strict runtime config parsing with user, chat, and thread allowlists.
- Added safe Telegram HTML/Markdown rendering helpers and Markdown-aware
  message splitting tests.
- Extracted queue state helpers and upload cleanup helpers with focused tests.
- Added `/cleanup_uploads` and `/cleanup_uploads_confirm` for downloaded image
  retention cleanup.
- Added the `codex-telegram-bot` package executable for `npx` and global
  installs.
- Added lint, format, audit, package, release, and rollback verification
  coverage.
- Split the runtime into `src/runtime.js` while keeping `src/bot.js` as a thin
  entrypoint.

## 1.0.5 - 2026-05-21

- Updated `@openai/codex-sdk` and the public development `@openai/codex` CLI
  package to `0.132.0`.

## 1.0.4 - 2026-05-17

- Moved cleanup action messages, status text, and result summaries into locale
  files.
- Removed remaining hard-coded Korean/English Telegram UI branches from the
  public bot code.
- Improved translation extensibility so new languages can be added by filling
  `src/locales/<lang>.json`.

## 1.0.3 - 2026-05-17

- Improved cleanup action button feedback.
- Added cleanup callback acknowledgements for missing, expired, ignored, and
  active cleanup actions.
- Replaced cleanup action buttons with a temporary processing state to prevent
  accidental duplicate execution.

## 1.0.2 - 2026-05-15

- Added locale-based Telegram UI translations under `src/locales/*.json`.
- Added a translation guide and locale validation command for contributor PRs.
- Synced Telegram command-menu descriptions with the selected UI language.
- Expanded time zone settings into a hierarchical region/UTC-offset menu.
- Normalized Back buttons so they appear at the bottom of control panels.
- Added real Telegram screenshots to the README.

## 1.0.1 - 2026-05-15

- Fixed slash-prefixed non-command text handling so paths like `/home/...` are
  passed to Codex instead of being ignored.
- Added GitHub Actions CI.
- Added optional Codex OAuth PR review and failed CI diagnosis workflows.
- Added automated `@openai/codex-sdk` and `@openai/codex` update testing and
  PR creation.
- Added public project hygiene files: security policy, changelog, contribution
  guide, issue templates, PR template, Dependabot, architecture docs, and
  security model docs.
- Expanded the Korean README.
- Updated GitHub Actions to Node 24 action runtimes.

## 1.0.0 - 2026-05-15

- Initial public release.
- Added Telegram bridge for Codex CLI via `@openai/codex-sdk`.
- Added queue modes, inline settings, image input support, cleanup, backups,
  export, health checks, and maintenance tools inspired by keep-codex-fast.
- Added English and Korean README files, hero image, and MIT license.
