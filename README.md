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
  <a href="https://github.com/woosungchoi/codex-telegram-bot/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/woosungchoi/codex-telegram-bot/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/woosungchoi/codex-telegram-bot/releases"><img alt="Release" src="https://img.shields.io/github/v/release/woosungchoi/codex-telegram-bot"></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-green"></a>
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
- Recovers interrupted streamed turns by checking Codex session logs before retrying work.
- Adds backup-first cleanup and local maintenance tools inspired by keep-codex-fast.

## Screenshots

Real Telegram screenshots from a running bot:

| Control panel | Settings | Telegram session |
| --- | --- | --- |
| <img src="assets/screenshots/main-control.jpg" alt="Telegram main control panel screenshot" width="260"> | <img src="assets/screenshots/settings-panel.jpg" alt="Telegram settings panel screenshot" width="260"> | <img src="assets/screenshots/telegram-session.jpg" alt="Telegram Codex session screenshot" width="260"> |

The safe local-state maintenance tools were inspired by
[keep-codex-fast](https://github.com/vibeforge1111/keep-codex-fast): inspect
first, back up before mutating, archive instead of deleting, and create
handoffs before retiring important active threads.

## Setup

Run from a local clone:

```bash
cd ~/codex-telegram-bot
npm install
cp .env.example .env
chmod 600 .env
```

After creating `.env` in the current directory, you can also run the package
command without keeping a clone:

```bash
npx --yes --package github:woosungchoi/codex-telegram-bot codex-telegram-bot
```

For repeated use, install the command globally:

```bash
npm install --global github:woosungchoi/codex-telegram-bot
codex-telegram-bot
```

For the smallest starting point, use:

```bash
cp .env.minimal.example .env
chmod 600 .env
```

`.env` contains credentials and must remain owner-only. Runtime state can
contain chat/thread metadata, queued work, uploads, recovery records, and
backups, so the bot also creates sensitive state files with mode `0600` and
their directories with mode `0700`.

Edit `.env`:

- `TELEGRAM_BOT_TOKEN`: token from `@BotFather`
- `ALLOWED_USER_IDS`: comma-separated positive Telegram numeric user ids
- `ALLOWED_CHAT_IDS`: optional comma-separated numeric chat ids. Negative group/supergroup chat ids are allowed. When set, authorized users are accepted only in these chats.
- `ALLOWED_THREAD_IDS`: optional comma-separated positive forum topic/thread ids. When set, authorized users are accepted only in these threads.
- `CODEX_WORKDIR`: defaults to `$HOME`
- `CODEX_PATH`: Codex executable, default `codex`. Set this explicitly if Codex is not on `PATH`.
- `CODEX_TRANSPORT`: `sdk` or `app-server-direct`, default `sdk`. Keep `sdk` for normal installs. Use `app-server-direct` only when your Codex CLI supports direct `app-server --stdio`.
- `CODEX_WORKER_MODE`: `sidecar` or `inline`, default `sidecar`. `sidecar` runs Codex turns in `codex-telegram-worker`; `inline` keeps the old single-process fallback.
- `CODEX_WORKER_STATE_DIR`: worker job state and event log directory, default `./state/worker`
- `CODEX_WORKER_SOCKET`: Unix socket used by the bot to talk to the worker, default `CODEX_WORKER_STATE_DIR/worker.sock`
- `CODEX_WORKER_CONNECT_TIMEOUT_MS`: worker RPC timeout, default `5000`
- `CODEX_WORKER_EVENT_POLL_MS`: bot polling interval for worker job events, default `1000`
- `CODEX_APP_SERVER_DIRECT_TIMEOUT_MS`: timeout for optional direct app-server requests, default `5000`
- `CODEX_SESSIONS_DIR`: defaults to `$CODEX_HOME/sessions`
- `CODEX_MODELS_CACHE_FILE`: Codex model cache used by Telegram model buttons, default `$CODEX_HOME/models_cache.json`
- `CODEX_MODEL`: global default model. The global `CODEX_REASONING_EFFORT` must be supported by the global `CODEX_MODEL`; Telegram validates known per-chat model/effort pairs against current Codex catalog capabilities.
- `CODEX_REASONING_EFFORT`: global default reasoning effort. Current Codex catalog capabilities drive the picker, and Telegram rejects an effort that the selected known model does not advertise. Max (`max`) provides deep single-task reasoning. Ultra (`ultra`) enables automatic delegation and appears only when the catalog advertises it. Higher efforts can increase latency and usage.
- `CODEX_BASE_URL`, `CODEX_API_KEY`, `CODEX_CONFIG_JSON`, `CODEX_ENV_JSON`: optional `Codex` SDK constructor settings
- `CODEX_MODEL_CONTEXT_WINDOW`: optional raw Codex `model_context_window` override. Standard OpenAI/Codex users should leave this and `CODEX_AUTO_COMPACT_TOKEN_LIMIT` blank so model changes use native context and automatic-compaction limits. For a custom provider or special deployment, an explicit value replaces the raw catalog context before Codex applies the model's effective-window percentage. When set with `CODEX_CONTEXT_COMPACT_THRESHOLD_PERCENT`, the bot derives `model_auto_compact_token_limit`.
- `CODEX_AUTO_COMPACT_TOKEN_LIMIT`: optional Codex `model_auto_compact_token_limit` override. Leave it blank to use the native per-model threshold; an explicit value directly replaces that threshold for a custom provider or special deployment.
- `CODEX_TOOL_OUTPUT_TOKEN_LIMIT`: optional Codex `tool_output_token_limit` override for reducing stored tool output pressure.
- `CODEX_COMPACT_STRENGTH`: compact prompt style, `default`, `light`, `balanced`, or `aggressive`; `default` leaves Codex's built-in compact prompt unchanged.
- `CODEX_COMPACT_PROMPT_FILE`: optional Codex `experimental_compact_prompt_file` path. When set, it takes precedence over `CODEX_COMPACT_STRENGTH`.
- `CODEX_CONTEXT_GUARD_ENABLED`: send a short Telegram notice when the connected thread is near the configured context threshold, default `true`
- `CODEX_CONTEXT_COMPACT_THRESHOLD_PERCENT`: context usage percentage used for guard notices and for deriving `CODEX_AUTO_COMPACT_TOKEN_LIMIT` when `CODEX_MODEL_CONTEXT_WINDOW` is set, default `75`
- `CODEX_CONTEXT_MIN_REMAINING_TOKENS`: also notify when the current thread has this many or fewer tokens remaining, default `40000`
- `CODEX_SKIP_GIT_REPO_CHECK`: allow Codex turns outside a Git repository, default `false`; set `true` only when you intentionally want Codex to run outside Git worktrees
- `CODEX_PERSONA_PROMPT`: optional override style instruction prepended to every Codex turn. Leave it empty to use the built-in prompt matching `TELEGRAM_LANGUAGE`. The bot always appends built-in Telegram rich Markdown formatting guidance for the selected language.
- `TELEGRAM_REACTIONS_ENABLED`: enable processing result reactions on inbound messages, default `true`
- `TELEGRAM_THINKING_REACTION`, `TELEGRAM_COMPLETE_REACTION`, `TELEGRAM_ERROR_REACTION`, `TELEGRAM_STOPPED_REACTION`: reaction emoji for processing states
- `TELEGRAM_FORMAT_CODEX_ANSWERS`: `markdown` sends Codex answers through Telegram rich Markdown first and falls back to safe Telegram HTML, `safe` renders only code spans/blocks, `off` sends plain text
- `TELEGRAM_LANGUAGE`: Telegram menu/panel language and default Codex response language. Any language file in `src/locales/*.json` can be used; default `en`. It can also be changed from `/settings` → `Language`.
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
- `CLEANUP_NOTIFY_CHAT_IDS`: optional comma-separated numeric chat ids for daily cleanup reminders. Negative group/supergroup chat ids are allowed.
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
- `BOT_RESTART_RECOVERY_ENABLED`: enable restart recovery marker, startup recovery, and manual recovery controls, default `true`
- `BOT_RESTART_EXIT_CODE`: exit code used by planned self-restart, default `75`
- `BOT_RESTART_DRAIN_TIMEOUT_SECONDS`: maximum wait before planned restart exits after writing recovery marker, default `900`
- `BOT_RESTART_DELAY_SECONDS`: delay between restart request and process exit, default `3`
- `BOT_RECOVERY_DIR`: recovery marker/journal directory, default `./state/recovery`
- `BOT_RECOVERY_STALE_SECONDS`: maximum age for automatic startup recovery candidates, default `21600`
- `BOT_RECOVERY_TURN_TTL_SECONDS`: recovery queue item TTL, default `86400`
- `BOT_RECOVERY_SUSPEND_AFTER`: suspend automatic recovery after this many attempts for the same key, default `3`
- `BOT_RECOVERY_BACKFILL_POLL_MS`: during startup recovery turns, poll Codex session backfill at this interval, default `30000`; set `0` to disable
- `CODEX_STREAM_IDLE_NOTICE_MS`: stream idle time before a recovery notice is sent, default `120000`
- `CODEX_STREAM_IDLE_ABORT_MS`: stream idle time before the SDK turn is aborted, default `900000`
- `UPLOAD_DIR`: directory for Telegram image inputs downloaded before sending them to Codex, default `./state/uploads`
- `UPLOAD_RETENTION_DAYS`: image uploads older than this become upload cleanup candidates, default `7`
- `UPLOAD_MAX_BYTES`: upload directory size target and per-file download cap in bytes, default `1073741824`, `0` disables the size target and download cap
- `UPLOAD_CLEANUP_ENABLED`: include upload cleanup dry-run plans in the daily cleanup scheduler, default `true`
- `BACKUP_DIR`: manual backup, chat export, and daily snapshot directory, default `./state/backups`
- `SNAPSHOT_ENABLED`: enable daily state snapshots, default `true`
- `SNAPSHOT_NOTIFY_TIME`: daily snapshot time in `TELEGRAM_TIME_ZONE`, default `03:30`
- `SNAPSHOT_RETENTION_DAYS`: backup/snapshot retention in days, default `14`
- `LOGS_MAX_LINES`: maximum `/logs` lines returned to Telegram, default `80`

Then run both processes in sidecar mode:

```bash
npm run start:worker
npm start
```

For local release-style verification, run:

```bash
npm run verify
```

## Codex Worker, Transport, and Recovery

The default runtime is `CODEX_WORKER_MODE=sidecar` with
`CODEX_TRANSPORT=sdk`. In this mode `codex-telegram-worker` owns Codex turn
execution and writes a durable per-job JSONL event log. The Telegram bot owns
Telegram updates, menus, replies, and delivery cursors.

This split is the primary bot restart recovery mechanism. If
`codex-telegram-bot.service` restarts while a turn is running, the worker keeps
the Codex stream alive. On startup, the bot reconnects to the worker, replays
events after the saved cursor, and sends the final answer or failure message.

SDK stream backfill is still kept as a fallback. If the SDK stream goes idle or
the worker itself is unavailable, recovery can still inspect the matching
`CODEX_SESSIONS_DIR` rollout JSONL for an agent message plus `task_complete`.
This fallback avoids starting duplicate work when Codex already completed.

`CODEX_WORKER_MODE=inline` is a development and emergency fallback. In inline
mode the bot executes Codex directly, so a bot process restart also interrupts
the active stream.

`CODEX_TRANSPORT=app-server-direct` is optional. The worker starts a direct
stdio child process with:

```bash
codex app-server --stdio
```

There is no app-server daemon, daemon autostart, daemon version check, or proxy
process. Public installs only need the regular Codex CLI/SDK path for the
default `sdk` transport. Use `app-server-direct` only when the installed Codex
CLI provides compatible direct stdio app-server support.

Telegram controls:

- Open `/settings` -> `Runtime` -> `Codex`
- Choose worker mode: `sidecar`, `inline`, or `Default`
- Choose transport: `SDK`, `app-server direct`, or `Default`
- Use `Test worker` to check the sidecar socket
- Use `Test app-server direct` to check direct app-server CLI support
- Use `Save & restart` after changing worker mode or transport

Use `/whoami` in the target chat or forum topic to confirm your Telegram user
id, chat id, and thread id before tightening `ALLOWED_CHAT_IDS` or
`ALLOWED_THREAD_IDS`. Callback buttons use the same user/chat/thread guard as
normal messages.

## GitHub Automation

This repository includes GitHub Actions for CI, optional Codex review,
authless failed-CI diagnosis, dependency update PRs, and guarded dependency PR
auto-merge.

- `CI`: runs `npm ci`, `npm run verify`, `actionlint`, `npm pack --dry-run --json`, and `npm run build --if-present` on pull requests and pushes to `main`.
- `Codex PR Review`: runs `codex review` on pull requests and updates one PR comment when Codex OAuth login is available. It is intentionally optional and should not be a required merge check.
- `Codex CI Diagnosis`: when `CI` fails, always posts deterministic diagnostics from GitHub Actions metadata, failed jobs, failed steps, and failed log excerpts. When Codex OAuth login is available, it appends an optional AI diagnosis. If the failed run is not attached to a PR, the diagnosis is written to the workflow step summary instead.
- `Codex Dependency Update`: checks the latest `@openai/codex-sdk` and
  `@openai/codex`, installs them, runs `npm run check`, `npm test`, and
  `codex --version`, then opens or updates a PR only when the update passes.
- `Dependency PR Auto Merge`: listens for successful verification runs and only
  squash-merges dependency PRs from `dependabot/*` or
  `automation/update-codex-packages` when the merge state is clean, all checks are
  successful/neutral/skipped, and the changed files stay within the dependency
  allowlist.

Recommended `main` branch protection keeps the deterministic CI matrix as the
required gate and leaves helper workflows report-only:

- Required status checks: `Check Node 18`, `Check Node 20`, `Check Node 22`
- Not required: `Codex PR Review`, `Codex CI Diagnosis`, `Dependency PR Auto Merge`

The normal pull-request flow is:

1. A PR opens or updates.
2. `CI` runs the Node 18/20/22 verification matrix.
3. If CI succeeds, the PR can merge after branch-protection checks pass.
4. If CI fails, `Codex CI Diagnosis` posts an authless diagnosis comment on the PR.
5. Optional Codex AI review/diagnosis runs only when `CODEX_ACCESS_TOKEN` is available.

The automated dependency flow is:

1. `Codex Dependency Update` or Dependabot opens a dependency-only PR.
2. `CI` validates the PR.
3. `Dependency PR Auto Merge` re-checks the PR head, file allowlist, merge state,
   and check rollup before squash-merging and deleting the branch.
4. A `main` push then runs `CI` again as the final verification.

The Codex workflows do not use `OPENAI_API_KEY`. `CODEX_ACCESS_TOKEN` is optional:
`Codex PR Review` and the AI add-on in `Codex CI Diagnosis` only run when the
repository secret is configured for Codex OAuth login:

```bash
gh secret set CODEX_ACCESS_TOKEN --body "$CODEX_ACCESS_TOKEN"
```

If that secret is not configured or expires, the Codex AI steps skip cleanly. Normal CI,
deterministic CI diagnosis, dependency updates, and auto-merge safety checks still run.

Dependabot is also configured to check `@openai/codex-sdk` and `@openai/codex`
daily, and other npm dependencies weekly.

## Project Docs

- [Architecture](docs/architecture.md)
- [Security model](docs/security-model.md)
- [Release checklist](docs/release-checklist.md)
- [Rollback](docs/rollback.md)
- [Screenshot guide](docs/screenshots.md)
- [Translation guide](docs/translations.md)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)

## Translations

Telegram menu text, button labels, and command descriptions are loaded from
`src/locales/*.json`. To add a language, copy `src/locales/en.json`, translate
the values, update `_meta`, and run:

```bash
npm run validate:locales
```

See `docs/translations.md` for the PR checklist and locale metadata format.

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
- `/status` also includes a short Codex usage summary when the current thread log has token count data, shows the sample age, and marks reset-passed limits as stale instead of showing old percentages as current. The `Refresh usage` button can run a tiny separate Codex probe turn to fetch a fresher usage sample; it may consume a small amount of quota.
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
- `/cleanup_uploads`, `/cleanup_uploads_confirm`: preview old downloaded Telegram image inputs; deletion requires the inline confirm button
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
- `/reasoning`, `/reasoning_minimal`, `/reasoning_low`, `/reasoning_medium`, `/reasoning_high`, `/reasoning_xhigh`, `/reasoning_default`: open, set, or reset reasoning. `/reasoning max` and `/reasoning ultra` select those efforts when the current catalog advertises them for the selected model; Telegram rejects unsupported efforts for a known selected model.
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
Every Codex turn also receives built-in language-specific instructions to make
good use of Telegram rich Markdown: headings, tables, lists, preformatted code
blocks, dividers, bold text, inline code, and fenced code blocks when they make
the answer easier to scan. This formatting guidance is still appended when
`CODEX_PERSONA_PROMPT` overrides the default persona prompt, and the user's
explicitly requested format takes priority.
Markdown mode sends raw answer Markdown through Telegram rich messages first,
so tables, dividers, headings, lists, bold/italic text, inline code, and fenced
code blocks can render with native Telegram rich formatting. A short inline
code span that appears alone on its own line is promoted to a one-line rich code
block so Telegram can render it with a compact background block. If rich
messages are unavailable or rejected, the bot falls back to the existing
Telegram HTML renderer. Raw HTML is escaped in the fallback path, and HTML parse
failures fall back to plain text so malformed output cannot prevent delivery.

## Runtime Overrides

`.env` defines startup defaults. Safe user-facing settings can also be changed
from `/settings` without editing `.env`; these overrides are stored in bot state
and take precedence until reset to `Default`.

Menu-managed runtime settings include:

- output: reactions, answer format, completion notice delay, maximum message
  length, log output line count, and progress edit interval
- queue: pending turn limit and pending turn expiry
- Codex: worker mode, worker poll interval, transport, app-server direct timeout, worker/app-server status checks, and save-and-restart
- live progress: mode and interval, plus per-chat source/delete controls
- cleanup: enable/disable, notify time, retention, quarantine, and approval TTL
- snapshots: enable/disable, notify time, and retention
- UI: language, time zone, and locale

Secrets, tokens, absolute paths, and process-level Codex constructor values
still belong in `.env`. Worker mode and transport changes are saved in bot
state, but the running services should be restarted after switching them.

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

Downloaded Telegram image inputs are stored under `UPLOAD_DIR` before they are
sent to Codex. `/cleanup_uploads` previews files older than
`UPLOAD_RETENTION_DAYS` or selected to bring the directory below
`UPLOAD_MAX_BYTES`; files are deleted only after pressing the inline
`Confirm upload cleanup` button. The legacy `/cleanup_uploads_confirm` typed
command now points operators back to `/cleanup_uploads` and does not delete
files.

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

For an existing default-path installation, stop the services before the
one-time permission correction below. `find -P` does not follow symlinks.
Inspect and handle any symlink separately; do not apply these recursive
commands blindly to a custom state path that may contain user-managed files.

```bash
systemctl --user stop codex-telegram-bot.service codex-telegram-worker.service
chmod 600 .env
find -P state -xdev -type d -exec chmod 700 -- {} +
find -P state -xdev -type f -exec chmod 600 -- {} +
find -P state -xdev -type s -exec chmod 600 -- {} +
```

```bash
mkdir -p ~/.config/systemd/user
cp ~/codex-telegram-bot/systemd/codex-telegram-bot.service ~/.config/systemd/user/
cp ~/codex-telegram-bot/systemd/codex-telegram-worker.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now codex-telegram-worker.service codex-telegram-bot.service
systemctl --user status codex-telegram-worker.service
systemctl --user status codex-telegram-bot.service
```

After updating either installed unit, copy both current unit files again,
then run `systemctl --user daemon-reload` and restart the worker before the
bot so the effective `UMask=0077` takes effect.

```bash
systemctl --user daemon-reload
systemctl --user restart codex-telegram-worker.service
systemctl --user restart codex-telegram-bot.service
```

Logs:

```bash
journalctl --user -u codex-telegram-worker.service -f
journalctl --user -u codex-telegram-bot.service -f
```

## License

MIT License. See [LICENSE](LICENSE).
