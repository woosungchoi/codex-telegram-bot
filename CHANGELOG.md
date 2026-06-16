# Changelog

All notable public changes are documented here.

## Unreleased

## 1.1.4 - 2026-06-16

### Added

- Added local image artifact delivery for Codex answers. When an answer
  contains a standalone `[[telegram_photo:/absolute/path|caption=...]]`
  directive, the bot removes that directive from the text reply and sends the
  referenced image as a native Telegram photo message.
- Added standalone Markdown image artifact support for local files such as
  `![caption](/absolute/path.png)`. This lets Codex responses use familiar
  Markdown while the Telegram runtime converts the image line into
  `replyWithPhoto` instead of displaying a raw local filesystem path.
- Added image artifact validation before upload. The runtime now requires an
  absolute path, an allowed image extension, an allowed artifact root, and an
  existing regular file before attempting to send the photo.
- Added topic-aware photo replies. Image artifacts are sent with the current
  Telegram chat and forum topic context, preserving `message_thread_id` for
  topic conversations.
- Added fallback reporting for rejected or failed image uploads. Unsupported,
  missing, or out-of-root artifacts are reported in the text reply, and upload
  failures keep the file path visible without exposing secrets.

### Changed

- Updated the Codex package baseline to `@openai/codex-sdk` `0.140.0` through
  the automated dependency update flow.

### Tests

- Added Telegram photo artifact tests covering directive parsing, standalone
  Markdown image parsing, allowed-root validation, unsupported contexts inside
  fenced code blocks, topic-aware `replyWithPhoto` payloads, photo-only
  answers, and upload failure fallback text.
- Verified the release with `npm run verify`, including syntax checks, locale
  validation, ESLint, Prettier package/workflow checks, the full Node test
  suite, and `npm audit --audit-level=moderate`.

## 1.1.3 - 2026-06-15

### Added

- Added restart recovery for active Codex turns. The bot now records active
  turn snapshots, planned restart markers, and recovery journal events under
  the recovery state directory so in-flight work can be resumed after a restart.
- Added startup recovery planning. Fresh restart markers and active turn
  snapshots are converted into recovery queue items before Telegram polling
  starts, and recovery turns resume the saved Codex thread id when one exists.
- Added planned self-restart support through `/restart`, `/restart_continue`,
  and `SIGUSR2`. Planned restarts write a recovery marker, wait briefly for
  active work to drain, and then exit with the configured restart code.
- Added direct shutdown recovery handling for process stops such as
  `systemctl --user restart`. The bot writes best-effort recovery markers and
  preserves persisted snapshots before exiting.
- Added manual recovery controls: `/recovery_status`, `/recovery_resume`, and
  `/recovery_cancel`.
- Added recovery queue metadata for Telegram topics and replies, including
  message thread ids, origin message ids, origin update ids, and reply targets.
- Added synthetic Telegram context helpers so persisted queue and recovery
  items can reply back to the correct chat/topic after process restart.
- Added recovery prompt guidance that asks Codex to inspect repo state, service
  state, logs, and tests before resuming a saved task, reducing duplicate or
  unsafe execution after restart.
- Added restart recovery configuration options:
  `BOT_RESTART_RECOVERY_ENABLED`, `BOT_RESTART_EXIT_CODE`,
  `BOT_RESTART_DRAIN_TIMEOUT_SECONDS`, `BOT_RESTART_DELAY_SECONDS`,
  `BOT_RECOVERY_DIR`, `BOT_RECOVERY_STALE_SECONDS`,
  `BOT_RECOVERY_TURN_TTL_SECONDS`, and `BOT_RECOVERY_SUSPEND_AFTER`.

### Changed

- Changed the package `codex-yolo` launcher to prefer the package-local
  `node_modules/.bin/codex` binary before falling back to a globally installed
  `codex`, while still respecting `CODEX_REAL_PATH`.
- Changed planned restart signaling from `SIGUSR1` to `SIGUSR2`, avoiding
  Node.js inspector activation on `SIGUSR1`.
- Registered restart and shutdown signal handlers earlier during bootstrap, so
  recovery state is available even if startup fails before Telegram polling
  launches.
- Moved startup recovery scheduling ahead of Telegram bot launch, ensuring
  saved recovery work is queued before new incoming updates are processed.
- Queued normal user input behind pending startup recovery work while recovery
  is active.
- Applied recovered Codex thread ids to chat state before resuming recovery
  turns, and cleared mismatched cached thread ids when recovery data indicates a
  different active thread.
- Recorded Telegram startup recovery notice delivery and failure events in the
  recovery journal.
- Updated `/status` context usage reporting to prefer the last turn's token
  usage for context-window pressure while still showing cumulative thread usage
  separately.
- Kept the public dependency baseline from `origin/main`, including ESLint
  `10.5.0`.

### Fixed

- Cleared empty and stale restart markers during startup recovery planning.
- Made direct `SIGTERM` shutdown exit explicitly after marker flush and
  Telegram stop, preventing a user service restart from waiting until a hard
  timeout.
- Made `/recovery_cancel` remove pending recovery queue items in addition to
  marking recovery state as cancelled.
- Deduplicated repeated Telegram `/restart` updates by update id.
- Warned and suspended automatic recovery after repeated failures for the same
  recovery key, preventing restart recovery loops.
- Preserved Telegram topic routing for persisted pending queue items and
  recovery replies.
- Preserved restart recovery snapshots on `SIGTERM` instead of deleting them
  before the next process can inspect them.

### Tests

- Added recovery state, journal, startup planning, controller, and shutdown
  tests.
- Added restart command tests for disabled recovery, no active turn,
  pending-queue restart, duplicate Telegram updates, and topic notification
  metadata.
- Added bootstrap signal tests for the `SIGUSR2` planned restart path and direct
  shutdown behavior.
- Added queue hydration and synthetic Telegram context tests for topic-aware
  queued/recovery replies.
- Added package launcher tests for package-local Codex CLI resolution.
- Added `/status` usage tests for last-turn context pressure versus cumulative
  thread usage.

## 1.1.2 - 2026-06-15

### Added

- Added same-thread Codex auto compact configuration support. The bot now maps
  dedicated environment variables into Codex CLI config overrides passed through
  `@openai/codex-sdk`, so long-running Telegram conversations can continue in
  the same Codex thread while Codex performs its native context compaction.
- Added `CODEX_MODEL_CONTEXT_WINDOW` for optional `model_context_window`
  overrides. When this is set and `CODEX_AUTO_COMPACT_TOKEN_LIMIT` is not set,
  the bot derives `model_auto_compact_token_limit` from
  `CODEX_CONTEXT_COMPACT_THRESHOLD_PERCENT`.
- Added `CODEX_AUTO_COMPACT_TOKEN_LIMIT` for explicit
  `model_auto_compact_token_limit` control when the desired token threshold is
  known.
- Added `CODEX_TOOL_OUTPUT_TOKEN_LIMIT` to pass Codex
  `tool_output_token_limit`, reducing pressure from large command, file, and web
  output in persisted thread context.
- Added `CODEX_COMPACT_STRENGTH` with `default`, `light`, `balanced`, and
  `aggressive` modes. The non-default modes select compact prompts that retain
  the current goal, constraints, decisions, relevant files, commands,
  verification results, risks, and next steps at different detail levels.
- Added `CODEX_COMPACT_PROMPT_FILE` to pass Codex
  `experimental_compact_prompt_file`. When set, the prompt file takes precedence
  over `CODEX_COMPACT_STRENGTH`.
- Added a context guard controlled by `CODEX_CONTEXT_GUARD_ENABLED`,
  `CODEX_CONTEXT_COMPACT_THRESHOLD_PERCENT`, and
  `CODEX_CONTEXT_MIN_REMAINING_TOKENS`. Before a turn runs, the guard reads the
  latest Codex `token_count` event from the connected session and sends a
  localized Telegram notice when the thread is near the configured threshold.
- Added English and Korean Telegram copy for the context guard notice. The
  notice reports context usage, remaining tokens, the auto compact limit, and
  that the bot will continue in the same thread.
- Added focused compact-helper tests for config mapping, derived compact limits,
  prompt-file precedence, default prompt behavior, and token-pressure parsing.
- Added config tests for the new compact/context environment variables and
  validation of invalid compact strength and percent values.

### Changed

- Updated the SDK constructor configuration summary to show the effective auto
  compact token limit, compact strength, and context guard thresholds.
- Updated backup/config summaries so exported state reports the compact and
  context guard settings without exposing secrets.
- Documented the new compact/context settings in both the English and Korean
  READMEs.

### Maintenance

- Ignored local CodeGraph state with `.codegraph/` so generated graph databases
  are not included in public commits.
- Updated the package version and public baseline test for `1.1.2`.

## 1.1.1 - 2026-06-14

- Added persistent language-specific Telegram rich Markdown style instructions
  to every Codex turn, so answers are encouraged to use headings, tables,
  lists, preformatted code blocks, dividers, bold text, inline code, and fenced
  code blocks when useful.
- Kept custom `CODEX_PERSONA_PROMPT` overrides compatible by appending the rich
  Markdown formatting guidance after the custom persona prompt.
- Added focused prompt tests for English, Korean, custom persona overrides, and
  language fallback behavior.
- Documented the persistent formatting guidance in the English and Korean
  READMEs.

## 1.1.0 - 2026-06-14

- Added Telegram rich Markdown delivery for Codex answers via
  `sendRichMessage`, enabling native rich rendering for tables, dividers,
  headings, lists, bold/italic text, inline code, and fenced code blocks when
  `TELEGRAM_FORMAT_CODEX_ANSWERS=markdown`.
- Preserved the existing `safe` and `off` answer-format modes and kept the
  Telegram HTML fallback for rich-message rejection or rich length limits.
- Promoted short standalone inline-code lines into one-line rich preformatted
  code blocks so Telegram can show compact background code blocks like Hermes.
- Added focused tests for rich payload preservation, topic/thread routing,
  fallback classification, long-message fallback, and standalone inline-code
  promotion.
- Documented the rich-first Markdown behavior in the English and Korean
  READMEs.

## 1.0.9 - 2026-06-11

- Improved `/status` usage reporting with explicit sample age and stale
  reset-passed limit handling, so old quota percentages are not shown as
  current values.
- Added an explicit `Refresh usage` status-panel button that runs a tiny
  separate Codex probe turn, after confirmation, to fetch a fresher usage
  sample without polluting the current chat thread.
- Added authless deterministic CI diagnosis for failed GitHub Actions runs, including failed job/step summaries, log-tail pattern classification, safe redaction, PR comments, and diagnosis artifacts.
- Kept Codex AI CI diagnosis optional: `CODEX_ACCESS_TOKEN` only gates the AI add-on, while basic CI diagnosis continues without Codex auth.
- Added an `actionlint` CI step for GitHub Actions workflow syntax/script checks.
- Updated development tooling and GitHub Actions dependencies.

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
