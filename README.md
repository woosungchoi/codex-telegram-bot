<p align="center">
  <img src="assets/readme-hero.png" alt="Codex Telegram Bot hero image" width="100%">
</p>

<h1 align="center">Codex Telegram Bot</h1>

<p align="center">
  <strong>Control Codex CLI from Telegram with queues, inline settings, images, cleanup, and safe maintenance tools.</strong>
</p>

<p align="center">
  <a href="README.ko.md">한국어</a>
</p>

<p align="center">
  <img alt="Node.js" src="https://img.shields.io/badge/Node.js-18%2B-339933">
  <img alt="Telegram" src="https://img.shields.io/badge/Telegram-Bot-26A5E4">
  <img alt="Codex SDK" src="https://img.shields.io/badge/Codex-SDK-111827">
  <img alt="Runtime settings" src="https://img.shields.io/badge/Runtime-settings-0EA5E9">
</p>

## What It Does

- Runs Codex turns from Telegram text, replies, photos, and image documents.
- Queues messages while Codex is busy, with safe, interrupt, and side-thread modes.
- Provides inline settings for model, reasoning, sandbox, approval, web, language, time zone, locale, and runtime overrides.
- Sends short progress updates without streaming raw command logs or reasoning text.
- Adds backup-first cleanup and local maintenance tools inspired by keep-codex-fast.

The safe local-state maintenance tools were inspired by
[keep-codex-fast](https://github.com/vibeforge1111/keep-codex-fast): inspect
first, back up before mutating, archive instead of deleting, and create
handoffs before retiring important active threads.

## Setup

```bash
cd ~/codex-telegram-bot
npm install
cp .env.example .env
```

Edit `.env`:

- `TELEGRAM_BOT_TOKEN`: token from `@BotFather`
- `ALLOWED_USER_IDS`: comma-separated Telegram numeric user ids
- `CODEX_WORKDIR`: defaults to `$HOME`
- `CODEX_PATH`: Codex executable, default `codex`. Set this explicitly if Codex is not on `PATH`.
- `CODEX_SESSIONS_DIR`: defaults to `$CODEX_HOME/sessions`
- `CODEX_MODELS_CACHE_FILE`: Codex model cache used by Telegram model buttons, default `$CODEX_HOME/models_cache.json`
- `CODEX_BASE_URL`, `CODEX_API_KEY`, `CODEX_CONFIG_JSON`, `CODEX_ENV_JSON`: optional `Codex` SDK constructor settings
- `CODEX_PERSONA_PROMPT`: optional override style instruction prepended to every Codex turn. Leave it empty to use the built-in prompt matching `TELEGRAM_LANGUAGE`.
- `TELEGRAM_REACTIONS_ENABLED`: enable processing result reactions on inbound messages, default `true`
- `TELEGRAM_THINKING_REACTION`, `TELEGRAM_COMPLETE_REACTION`, `TELEGRAM_ERROR_REACTION`, `TELEGRAM_STOPPED_REACTION`: reaction emoji for processing states
- `TELEGRAM_FORMAT_CODEX_ANSWERS`: `markdown` renders a safe Markdown subset with Telegram HTML, `safe` renders only code spans/blocks, `off` sends plain text
- `TELEGRAM_LANGUAGE`: Telegram menu/panel language and default Codex response language, `en` or `ko`, default `en`; it can also be changed from `/settings` → `Language`
- `TELEGRAM_TIME_ZONE`: IANA time zone for reminders, date keys, and timestamps, default `UTC`; it can also be changed from `/settings` → `Time Zone`
- `TELEGRAM_LOCALE`: date/time display locale, default `en-US`; it can also be changed from `/settings` → `Locale`
- `TELEGRAM_COMPLETION_NOTICE_SECONDS`: send a short completion notice for long Codex turns, default `90`, `0` disables it
- `TELEGRAM_PENDING_TURNS_MAX`: maximum plain text/image messages queued while a Codex turn is running, default `10`
- `TELEGRAM_PENDING_TURN_MAX_AGE_SECONDS`: queued message expiry, default `7200` seconds, `0` disables expiry
- `TELEGRAM_LIVE_PROGRESS_ENABLED`: send short progress messages in the selected Telegram language while streamed Codex turns run, default `true`
- `TELEGRAM_LIVE_PROGRESS_INTERVAL_SECONDS`: minimum spacing for non-critical progress messages, default `30`
- `TELEGRAM_LIVE_PROGRESS_MODE`: progress wording mode, default `brief`; legacy `korean-brief` is still accepted
- `TELEGRAM_LIVE_PROGRESS_SOURCE`: `agent`, `activity`, or `both`; choose Codex comments, tool/file activity, or both, default `agent`
- `TELEGRAM_LIVE_PROGRESS_DELETE_POLICY`: `always`, `on_success`, or `never`; choose when temporary progress messages are deleted, default `on_success`
- `CLEANUP_ENABLED`: enable the daily Codex thread cleanup reminder, default `true`
- `CLEANUP_NOTIFY_TIME`: daily reminder time in `TELEGRAM_TIME_ZONE`, default `09:00`
- `CLEANUP_RETENTION_DAYS`: sessions older than this become quarantine candidates, default `14`
- `CLEANUP_QUARANTINE_DAYS`: quarantined sessions older than this become permanent delete candidates, default `7`
- `CLEANUP_QUARANTINE_DIR`: quarantine directory, default `$CODEX_HOME/session-quarantine`
- `CLEANUP_ARTIFACT_DIR`: cleanup plan/manifest/restore artifacts, default `./state/cleanup-artifacts`
- `CODEX_HOME`: Codex state root for cleanup and maintenance, default derived from `CODEX_SESSIONS_DIR`
- `CODEX_MAINTENANCE_SCRIPT`: helper script for the Codex maintenance Telegram menu, default `scripts/codex_maintenance.py`
- `CODEX_MAINTENANCE_BACKUP_DIR`: backup root for maintenance actions, default `./state/codex-maintenance`
- `CODEX_MAINTENANCE_WORKTREE_DAYS`: stale worktree archive cutoff, default `7`
- `CODEX_MAINTENANCE_LOG_ROTATE_MB`: `logs_2.sqlite*` rotation threshold, default `64`
- `CODEX_MAINTENANCE_THREAD_TITLE_LIMIT`: SQLite thread title metadata repair limit, default `120`
- `CODEX_MAINTENANCE_THREAD_PREVIEW_LIMIT`: SQLite first-message preview metadata repair limit, default `240`
- `CODEX_MAINTENANCE_AUTO_SQLITE_REPAIR_ENABLED`: run SQLite metadata repair from the daily cleanup scheduler, default `false`
- `CODEX_MAINTENANCE_AUTO_HANDOFF_ENABLED`: create active thread handoff docs from the daily cleanup scheduler, default `false`
- `CODEX_HANDOFF_DIR`: fallback handoff directory when a repo-local `docs/codex-handoffs` path cannot be used, default `$CODEX_HOME/handoffs`
- `CODEX_HANDOFF_RECENT_EVENTS`: number of recent session highlights included in generated handoff docs, default `40`
- `BACKUP_DIR`: manual backup, chat export, and daily snapshot directory, default `./state/backups`
- `SNAPSHOT_ENABLED`: enable daily state snapshots, default `true`
- `SNAPSHOT_NOTIFY_TIME`: daily snapshot time in `TELEGRAM_TIME_ZONE`, default `03:30`
- `SNAPSHOT_RETENTION_DAYS`: backup/snapshot retention in days, default `14`
- `LOGS_MAX_LINES`: maximum `/logs` lines returned to Telegram, default `80`

Then run:

```bash
npm start
```

## GitHub Automation

This repository includes GitHub Actions for CI, Codex PR review, and failed CI
diagnosis.

- `CI`: runs `npm ci`, `npm run check`, `npm test --if-present`, and `npm run build --if-present`.
- `Codex PR Review`: runs `codex review` on pull requests and updates one PR comment.
- `Codex CI Diagnosis`: when `CI` fails, runs `codex exec` on the CI log tail and comments on the PR when one exists.

The Codex workflows do not use `OPENAI_API_KEY`. They only run when the
repository secret `CODEX_ACCESS_TOKEN` is configured for Codex OAuth login:

```bash
gh secret set CODEX_ACCESS_TOKEN --body "$CODEX_ACCESS_TOKEN"
```

If that secret is not configured, the Codex jobs skip cleanly and the normal CI
still runs.

## Telegram Commands

The bot registers Telegram command suggestions with `setMyCommands()` at
startup. In Telegram, typing `/` opens a compact command menu. Most option
commands still work when typed directly, but the visible menu stays focused on
entry points.

- `/start` or `/help`: show help
- `/menu`: open the main inline-button control panel
- `/new`: start a real new Codex thread immediately and show the previous/new thread ids
- `/resume [thread-id|last]`: resume an existing Codex thread. Without an argument, it resumes the latest session found under `CODEX_SESSIONS_DIR`.
- `/status`: show the bound thread and config
- `/status` also includes a short Codex usage summary when the current thread log has token count data.
- `/queue`: show the queue panel with pause/resume, mode, clear, cancel, up, and next buttons
- `/settings`: open model, thinking, fast, sandbox, approval, web search, network, stream, live progress, runtime env-style overrides, language, time zone, locale, path, and schema buttons
- `/tools`: open health, doctor, logs, config, backup, export, cleanup, and forget buttons
- `/stop`: abort the current turn for this chat

Advanced direct commands are intentionally hidden from Telegram's visible menu
but remain available for typed use and automation:

- `/threads`: list recent Codex thread ids
- `/queue_pause`, `/queue_resume`: pause or resume automatic queued turn processing
- `/queue_mode`, `/queue_mode_safe`, `/queue_mode_interrupt`, `/queue_mode_side`: inspect or choose how new messages are handled while a Codex turn is running
- `/cancelqueue [id|number]`: clear all queued messages, or remove one queued item by id or 1-based number
- `/forget`: remove the saved thread binding
- `/cleanup`, `/cleanup_status`: show cleanup candidates and approval buttons
- `/backup`: create and upload a redacted JSON backup of bot state and cleanup log
- `/export`: create and upload the current chat's thread/options export
- `/prefs`, `/prefs_reset`: show or reset the current chat's preferences without forgetting the thread
- `/whoami`: show Telegram user/chat ids and authorization status
- `/logs`, `/logs_error`: show recent systemd user-service logs with token redaction
- `/options`: show chat-specific effective `ThreadOptions`
- `/config`: show process-level `Codex` constructor settings without secrets
- `/doctor`, `/health`: show process, SDK, CLI, model cache, disk, and state diagnostics
- `/model [name|off]`, `/model_off`: without arguments, show model selection buttons and then thinking selection
- `/fast`, `/fast_on`, `/fast_off`, `/fast_status`: toggle or inspect Codex `service_tier="fast"` for this chat
- `/workdir <absolute-dir|default>`, `/workdir_default`
- `/sandbox`, `/sandbox_read_only`, `/sandbox_workspace_write`, `/sandbox_danger_full_access`, `/sandbox_default`
- `/approval`, `/approval_never`, `/approval_on_request`, `/approval_on_failure`, `/approval_untrusted`, `/approval_default`
- `/reasoning`, `/reasoning_minimal`, `/reasoning_low`, `/reasoning_medium`, `/reasoning_high`, `/reasoning_xhigh`, `/reasoning_default`
- `/websearch`, `/websearch_disabled`, `/websearch_cached`, `/websearch_live`, `/websearch_default`
- `/network`, `/network_on`, `/network_off`, `/network_default`
- `/skipgit`, `/skipgit_on`, `/skipgit_off`, `/skipgit_default`
- `/adddir <absolute-dir>`
- `/cleardirs`
- `/stream`, `/stream_on`, `/stream_off`, `/stream_default`: choose SDK `runStreamed()` or buffered `run()`
- `/schema <json-schema|off>`, `/schema_off`: set `TurnOptions.outputSchema`

Plain text messages are sent to the current Codex thread. If no thread exists,
the bot starts one and saves the thread id after Codex emits it.

Telegram photos and image documents are downloaded locally and sent as SDK
`local_image` inputs alongside the caption text.

When a Telegram message is sent as a reply, the bot prepends the replied-to
message text/caption as context. If the replied-to message contains a photo or
image document, that image is also sent to Codex as a `local_image` input.

While Codex is processing an inbound Telegram message, additional plain text,
photo, or image-document messages are queued for the same chat and processed in
order after the active turn finishes by default. The queue is persisted in
`STATE_FILE`, so queued text and downloaded image paths survive a bot restart.
`/status` and `/queue` show the backlog. `/queue` also shows inline buttons for
pause/resume, queue mode, clear all, cancel one item, move an item up, or run an
item next. The direct commands `/queue_pause`, `/queue_resume`, `/cancelqueue`,
and `/cancelqueue <id|number>` remain available.

`/queue_mode` controls how new messages behave while a Codex turn is running:

- `safe`: queue the message and run it after the active turn. This is the default.
- `interrupt`: prepare the new message, put it at the front of the queue, abort the active turn, then run the new message next in the same thread.
- `side`: keep the active turn running and answer the new message in a separate side thread. Side replies are marked and should be treated as separate from the main thread context.

Queued items older than `TELEGRAM_PENDING_TURN_MAX_AGE_SECONDS` expire
automatically and the bot notifies the chat when it prunes them. Short status
questions such as "지금 뭐해?", "진행 상태?", or "status" are answered immediately
instead of being queued. `/stop` aborts the active turn, side turns, and queued
messages for that chat. When streaming is enabled, the bot also
sends short progress messages in the selected Telegram language, such as file checks, command execution, and
file changes. Those progress messages stay visible while the turn is running,
then are deleted after the final or error response is sent. It does not stream
raw command logs or reasoning text. The bot reacts to each message when it is
actually being processed. The default flow is `🤔` while processing, `👌` when
complete, `😢` on error, and `😴` when stopped. Long turns also get a compact
completion notice after `TELEGRAM_COMPLETION_NOTICE_SECONDS` when live progress
is disabled.

Bot-owned messages such as `/help`, `/status`, `/options`, `/config`,
`/threads`, and cleanup prompts are sent with Telegram HTML formatting. Dynamic
values are escaped centrally before being wrapped in `<code>` or `<pre>`.
Free-form Codex answers use `TELEGRAM_FORMAT_CODEX_ANSWERS=markdown` by default.
Markdown is parsed with `markdown-it`, then rendered through a Telegram HTML
allowlist: bold, italic, strikethrough, links, blockquotes, inline code, and
fenced code blocks. Raw HTML is escaped, and HTML parse failures fall back to
plain text so malformed output cannot prevent delivery.

## Runtime Overrides

`.env` defines startup defaults. Safe user-facing settings can also be changed
from `/settings` without editing `.env`; these overrides are stored in bot state
and take precedence until reset to `Default`.

Menu-managed runtime settings include:

- output: reactions, answer format, completion notice delay, maximum message
  length, log output line count, and progress edit interval
- queue: pending turn limit and pending turn expiry
- live progress: mode and interval, plus per-chat source/delete controls
- cleanup: enable/disable, notify time, retention, quarantine, and approval TTL
- snapshots: enable/disable, notify time, and retention
- UI: language, time zone, and locale

Secrets, tokens, absolute paths, and process-level Codex SDK constructor values
still belong in `.env` and require a service restart.

## Session Cleanup

The bot sends one cleanup reminder per day after `CLEANUP_NOTIFY_TIME` in
`TELEGRAM_TIME_ZONE`.
It only creates an approval plan; it does not move or delete files until a
Telegram inline button is pressed.

Default policy:

- Active Telegram-bound threads and currently running Codex thread ids are protected.
- Session logs older than `CLEANUP_RETENTION_DAYS` become quarantine candidates.
- Quarantined logs older than `CLEANUP_QUARANTINE_DAYS` become permanent delete candidates.
- Approval plans expire after `CLEANUP_PLAN_TTL_HOURS`.

Manual review is available with `/cleanup`.

The `/tools` panel also includes `Codex Maintenance` for keep-codex-fast-style
maintenance. Its report action is read-only. Backup, config prune, worktree
archive, and log rotate are backup-first and avoid permanent deletion. SQLite
metadata repair is a separate explicit button; it backs up first, only shortens
thread-list title/preview metadata, and leaves session JSONL transcripts intact.
Active thread handoff generation is also available as a button and writes a
repo-local `docs/codex-handoffs` draft when possible. Automatic repair and
automatic handoff generation are both off by default. The Telegram maintenance
menu can toggle those automatic options at runtime; the saved state defaults to
the environment values on first startup.

## systemd User Service

```bash
mkdir -p ~/.config/systemd/user
cp ~/codex-telegram-bot/systemd/codex-telegram-bot.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now codex-telegram-bot.service
systemctl --user status codex-telegram-bot.service
```

Logs:

```bash
journalctl --user -u codex-telegram-bot.service -f
```

## License

MIT License. See [LICENSE](LICENSE).
