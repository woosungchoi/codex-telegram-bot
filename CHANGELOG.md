# Changelog

All notable public changes are documented here.

## 1.2.8 - 2026-07-21

### Selection flows

- Reworked standalone `/model` into a single-message, cancellable selection
  flow. The bot now edits one prompt through model, model-aware reasoning, and
  optional Fast selection instead of sending a new message for every step.
- Added the same isolated, single-message behavior to standalone `/reasoning`,
  while keeping it independent from the Settings control panel.
- Kept a localized Cancel button visible at every standalone selection stage.
  Cancelling edits the existing prompt to a cancellation result, removes every
  button, and leaves the previously saved chat options unchanged.
- Deferred standalone model changes until the final required choice succeeds.
  Fast is requested only for models that advertise support, and a non-Fast
  model clears an incompatible stale Fast override during the atomic commit.
- Updated Settings -> Model to edit the existing control-panel message through
  reasoning and optional Fast selection while preserving Settings, Main, Back,
  and Close navigation. Settings selections retain their immediate-save
  behavior, so Close dismisses the panel without rolling back applied choices.

### Control panel navigation

- Added one localized Close row to every stable `/menu` panel and nested
  control-panel view, including Status, Queue, Settings, Runtime, Tools,
  Skills, maintenance results, model/reasoning/Fast choices, and confirmation
  screens.
- Applied the same Close affordance to the direct `/status`, `/queue`,
  `/settings`, and `/tools` panel commands for consistent control-panel
  behavior regardless of entry point.
- Made Close edit the current message to the localized menu-closed result and
  remove the entire inline keyboard without stopping an active Codex turn or
  creating a replacement Telegram message.
- Kept actual Busy/Processing states and separate cleanup or export result
  messages outside the Close decorator. This avoids presenting Close as task
  cancellation and prevents an in-flight result update from reopening a
  message the user just dismissed.

### Safety and correctness

- Added chat-bound, expiring selection tokens and phase claims so stale,
  superseded, duplicate, and out-of-order callbacks cannot commit a different
  selection or report a false cancellation.
- Preserved the previous options when Telegram message edits or durable state
  saves fail, leaving the active selection in a retryable and cancellable
  phase.
- Reconciled model and reasoning capabilities before mutation, including
  unsupported defaults, custom models, incompatible explicit reasoning, and
  catalog-advertised Fast support.
- Used strict edit-only behavior for selection completion, cancellation,
  expiry, and menu closing. Telegram parse fallback remains available, but an
  unavailable edit target never creates a second selection or closure message.
- Added complete English, Korean, and Traditional Chinese copy for selection
  prompts, completion, cancellation, expiry, processing, and menu closure.

### Dependencies and release hygiene

- Updated the audited transitive `brace-expansion` lock resolution from 5.0.6
  to 5.0.7, clearing the published denial-of-service advisory without changing
  the package's direct dependency surface.
- Kept the public `@openai/codex-sdk` and package-local `@openai/codex` CLI
  aligned at 0.144.6.

### Verification

- Added deterministic state-machine and runtime-harness coverage for atomic
  commit, cancel at every phase, expiry, duplicate callbacks, Fast capability,
  edit failure, save rollback, and active-turn rejection.
- Added keyboard coverage proving Close is immutable, idempotent, unique, and
  always placed last on stable panels while standalone Cancel and processing
  screens remain isolated.
- Confirmed the full syntax, locale, lint, format, test, package-audit, graph,
  and live service checks pass with the new interaction model.

## 1.2.7 - 2026-07-20

### Reliability

- Added an application-scoped Telegram HTTPS agent with keep-alive and a
  one-second address-family attempt timeout. The bot can move on to another
  viable address without pinning IPv4, IPv6, DNS answers, or Telegram IPs.
- Made typing, reaction, and live-progress delivery best-effort. A transient
  Telegram failure can no longer close the worker event iterator, cancel the
  Codex job, or turn a successful Codex execution into `turn_failed`.
- Separated completed Codex execution from final Telegram delivery with a
  durable worker-delivery ledger. Results now move through `result_ready`,
  `delivery_sending`, `delivery_failed`, and `delivery_sent` independently of
  the worker job's terminal status.
- Added read-only replay of completed worker event logs after a bot restart.
  A safely identified missing result can be reconstructed and delivered
  without starting a second Codex turn or mutating the original worker job.
- Preserved uncertain delivery state instead of retrying automatically when a
  transport error leaves Telegram receipt ambiguous. This deliberately favors
  duplicate prevention over speculative final-answer retries.

### Fixed

- Limited HTML-to-plain-text fallback to Telegram entity parsing failures.
  Network, authentication, flood-control, and server errors now remain single
  requests instead of accidentally issuing a second send.
- Treated `message is not modified` as a successful edit no-op and created a
  replacement reply only when Telegram explicitly reports that the original
  edit target is unavailable.
- Narrowed rich-message fallback to capability, parsing, and length
  rejections, while allowing transient network errors to propagate into the
  delivery state machine without duplicate fallback sends.
- Replaced active-turn snapshots when a new turn starts so stale worker job
  identifiers and recovery cursors cannot leak into later work.
- Queued new same-chat turns while a completed result is still pending final
  delivery, and exposed pending versus uncertain delivery counts in status
  output.

### Security and recovery safety

- Redacted Telegram bot-token segments from structured errors and journals.
  Delivery records store only sanitized error fields plus the final response
  digest and length, never the response body.
- Added chat, topic, job, snapshot, cursor, age, and response-digest guards to
  startup recovery. Stale, mismatched, user-stopped, incomplete, already-sent,
  and ambiguous candidates require manual review and are never auto-replayed.
- Pruned only old sent or safely orphaned legacy records. Pending and
  ambiguous entries remain durable across restarts.

### Dependencies and CI

- Updated `@openai/codex-sdk` and the package-local `@openai/codex` CLI from
  `0.144.1` to `0.144.6`, keeping the SDK and CLI versions aligned.
- Updated ESLint from `10.6.0` to `10.7.0`.
- Updated `actions/setup-node` from v6 to v7 across CI, release, dependency
  update, PR review, and CI diagnosis workflows.

### Verification

- Added deterministic coverage for Telegram transport classification,
  parse-only fallback, token redaction, progress fail-open behavior, delivery
  lifecycle transitions, recovery candidate selection, event-log replay,
  queue gating, snapshot replacement, and ledger pruning.
- Verified the progress fault-injection path consumes worker events through
  the terminal cursor after an injected timeout without a worker cancel or
  `turn_failed` transition.
- Exercised the core delivery suite on Node.js 18, 20, and 22, and completed a
  bot-only live rollout with the worker process left running.
- Confirmed one current legacy cursor gap was recovered exactly once without a
  new Codex job, older gaps were not sent, and a controlled sidecar turn showed
  both live progress and its final Telegram answer.

## 1.2.6 - 2026-07-10

### Fixed

- Prevented graceful worker restarts from leaving orphaned active jobs by
  tracking job tasks and waiting for their terminal state and active-index
  cleanup before shutdown completes.
- Reconciled persisted nonterminal jobs when a new worker process starts,
  marking interrupted work failed and removing stale active-index entries.
- Made `/stop` finalize persisted orphaned jobs even when the restarted worker
  no longer has their in-memory abort controller.
- Recorded normal cancellation requests before aborting the worker controller,
  preserving terminal event and state ordering.

### Verification

- Added deterministic regression coverage for delayed shutdown cleanup,
  startup orphan reconciliation, and controller-less orphan cancellation.
- Confirmed the full verification suite and package audit pass with worker
  active and running job counts returning to zero after cleanup.

## 1.2.5 - 2026-07-10

### Security

- Restricted runtime state, uploads, backups, recovery records, cleanup
  artifacts, worker job data, and Unix sockets to owner-only permissions.
- Created sensitive regular and atomic temporary files with mode `0600`, and
  sensitive runtime directories with mode `0700`, even under a permissive
  process umask.
- Corrected existing permissive files on write or append, and hardened copied
  backup trees without following symlinks.
- Added `UMask=0077` to both the bot and worker systemd user services.

### Changed

- Documented `chmod 600 .env` for standard and minimal installations.
- Added a symlink-safe one-time permission migration for existing default-path
  installations and restart guidance for updated systemd units.

### Verification

- Added regression coverage for forced `umask 0002`, atomic writes, append
  correction, symlink-safe tree hardening, worker sockets, recovery data,
  cleanup artifacts, and private bootstrap directories.
- Confirmed the full verification suite and package audit pass with the new
  permission invariants.

## 1.2.4 - 2026-07-10

### Added

- Added catalog-backed GPT-5.6 Sol, Terra, and Luna reasoning controls that
  preserve Codex's advertised effort order and descriptions.
- Added model-aware Telegram reasoning panels, callbacks, `/reasoning max`,
  `/reasoning ultra`, and matching shortcut commands. Ultra is shown only for
  models whose Codex catalog entry advertises it.
- Added explicit `gpt-5.6` alias handling for Sol while keeping unknown custom
  models on the conservative legacy reasoning choices.

### Changed

- Updated `@openai/codex-sdk` and `@openai/codex` to `0.144.1`, and updated
  Prettier to `3.9.5`.
- Kept `max` and `ultra` unchanged across the SDK, app-server-direct, and
  sidecar-worker execution paths.
- Documented that standard OpenAI/Codex deployments should leave the explicit
  context-window and auto-compact token overrides blank so model changes retain
  Codex's native limits.

### Fixed

- Validated the prospective effective model/reasoning pair before changing
  Telegram chat state. Unsupported inherited configured reasoning now rejects
  the transition without saving state or invalidating a cached thread.
- Registered the Max and Ultra shortcuts in the canonical Telegram command
  classifier, including entity-less command handling.
- Bounded untrusted catalog reasoning entries to the first 12 valid unique
  efforts, preventing oversized Telegram prompts and keyboards while preserving
  advertised order and default semantics.

### Verification

- Added regression coverage for model aliases, known-empty and unknown model
  behavior, forged or unsupported callbacks, command classification, state
  mutation ordering, transport propagation, and oversized catalogs.
- Confirmed the full verification suite, package audit, model-aware keyboard
  surface, rejected Luna/Ultra selection, and bounded Sol Max/Ultra turns.

## 1.2.3 - 2026-07-08

### Changed

- Reworked `/skills` into a compact inventory dashboard that reports unique,
  scanned, duplicate, status, and warning counts without spending the default
  Telegram message budget on long skill descriptions.
- Added display-level duplicate collapse for cached plugin skill copies while
  preserving source counts in detail output.
- Added short `sk:<view>:<page>` callback navigation for All, Local, Enabled,
  Cached, Disabled, and Warnings views.
- Added `/skills <query>` detail output so long descriptions are available on
  demand instead of crowding the default inventory.

### Fixed

- Prevented large enabled plugin inventories from being hidden behind a large
  "more omitted" count when the compact unique skill list fits Telegram's
  message limit.
- Parsed SKILL.md block-scalar `description: |` and `description: >` values so
  local custom skills no longer render a literal `|` as their description.
- Kept warning details out of the default `/skills` view while preserving
  sanitized warning output in the Warnings view.

### Verification

- Added focused display regression tests for compact pagination, duplicate
  collapse, warnings view, queried detail output, block-scalar descriptions, and
  bounded callback data.
- Confirmed the real Codex home inventory formats as `60 scanned`, `36 unique`,
  `24 duplicates`, `4 warnings`, and `1811` characters with no `more omitted`
  marker in the default output.
- Confirmed `npm run verify` passes, including recursive syntax checks, locale
  validation, ESLint, Prettier package/workflow checks, the full Node test
  suite, and `npm audit --audit-level=moderate`.

## 1.2.2 - 2026-07-08

### Added

- Added `/skill` as a Telegram command for inspecting the Codex skill inventory
  visible to the bot runtime.
- The new skills status view reports local system skills, local custom skills,
  enabled plugin skills, cached plugin skills, and disabled plugin declarations
  in one capped Telegram HTML response.
- Added observable warning output for inventory problems such as unreadable
  Codex config, ignored plugin config values, ignored plugin manifests, and
  ignored skill frontmatter, without exposing raw local exception details.
- Added English, Korean, and Traditional Chinese command descriptions and menu
  text for `/skill`, so Telegram's command list and the bot's localized UI
  surface the new command.

### Security

- Escaped all skill names and descriptions before formatting Telegram HTML.
- Redacted absolute filesystem paths, `file://` paths, URL-style file paths,
  delimiter-adjacent paths, punctuation-adjacent paths, and space-bearing local
  paths from untrusted skill metadata before replying in Telegram.
- Prevented plugin skill-root symlinks from escaping the plugin root while
  scanning cached plugin bundles.
- Kept frontmatter parsing intentionally narrow: scalar `name` and
  `description` values are accepted, while nested or unknown metadata remains
  ignored.

### Changed

- Split the skills status implementation into focused collector, formatter, and
  shared helper modules while keeping `src/codex/skills_status.js` as the public
  command facade.
- Moved the `/skill` test fixture builder into
  `test/helpers/codex_skills_status_fixture.mjs`, leaving the main test file
  focused on behavior.
- Replaced the package syntax-check glob with `scripts/check-syntax.mjs`, which
  recursively syntax-checks JavaScript and MJS files under `src`, `scripts`, and
  `test`. This prevents newly added nested helpers from silently escaping
  `npm run check`.

### Fixed

- Preserved the Telegram inline keyboard when refreshing the skills status view
  in edit mode.
- Capped the formatted skills inventory to the configured Telegram message
  length and reports omitted rows instead of overflowing the message body.
- Sanitized fallback output when skill inventory collection fails, so `/skill`
  still returns a bounded diagnostic response instead of throwing through the
  command handler.

### Verification

- Added focused `/skill` regression coverage for inventory collection, plugin
  manifest parsing, disabled plugin declarations, Telegram HTML escaping,
  message capping, path redaction, symlink containment, frontmatter parsing,
  missing-root warnings, reply mode, and edit mode.
- Confirmed the nested syntax-check script covers 106 JavaScript/MJS files in
  the current release tree.
- Confirmed locale validation covers English, Korean, and Traditional Chinese
  after adding the new `/skill` UI keys.
- Confirmed `npm run verify` passes, including recursive syntax checks, locale
  validation, ESLint, Prettier package/workflow checks, the full Node test
  suite, and `npm audit --audit-level=moderate`.
- Smoke-tested the `/skill` responder surface directly with reply and edit
  paths, including keyboard preservation and raw path redaction.

## 1.2.1 - 2026-07-06

### Added

- Added Traditional Chinese (`zh-tw`) as a Telegram UI language. The locale is
  loaded automatically from `src/locales/zh-tw.json`, appears in the language
  picker, and registers Telegram command descriptions for Telegram's `zh`
  language code.
- Translated the bot's menu panels, settings, queue controls, maintenance
  tools, cleanup flow, recovery notices, command descriptions, and PDF/document
  handling messages into Traditional Chinese.
- Added Traditional Chinese default Codex response-style instructions and
  Telegram Rich Markdown formatting guidance, so `TELEGRAM_LANGUAGE=zh-tw`
  keeps both UI text and default Codex replies aligned instead of falling back
  to English response-style prompts.

### Fixed

- Completed the locale against the current `1.2.x` message surface by adding
  strings introduced after the original PR branch was opened, including PDF
  upload details, unsupported document/message responses, restart recovery
  start notices, recovery idle warnings, recovery start-failure text, and
  recovery idle-timeout stop notices.
- Preserved all English placeholder tokens in the Traditional Chinese
  translations, including `{count}`, `{threadId}`, `{remaining}`, `{command}`,
  `{tool}`, `{paths}`, `{action}`, `{title}`, and other runtime substitution
  fields required by the Telegram UI.

### Verification

- Added a locale discoverability regression test proving `zh-tw` is present in
  `VALID_LANGUAGES`, `LANGUAGE_CHOICES`, and `TELEGRAM_LANGUAGE_CODES`, and that
  `textFor("zh-tw", "language")` returns the translated label.
- Extended Codex prompt tests to cover the Traditional Chinese persona and
  Telegram Rich Markdown guidance.
- Confirmed the locale validator accepts all three shipped locale files:
  English, Korean, and Traditional Chinese.
- Confirmed the release with `npm run verify`, including syntax checks, locale
  validation, ESLint, Prettier package/workflow checks, the full Node test
  suite, and `npm audit --audit-level=moderate`.
- Confirmed `npm pack --dry-run --json` includes `src/locales/zh-tw.json` and
  the updated runtime source/tests in the package payload.

## 1.2.0 - 2026-07-06

### Added

- Added `codex-telegram-worker` sidecar mode as the default runtime. The worker
  owns Codex turn execution, stores durable per-job JSONL events, and lets the
  Telegram bot reconnect and replay job events after a bot-only restart.
- Added worker IPC over a Unix socket with `worker/status`, `job/start`,
  `job/status`, `job/events`, and `job/cancel`.
- Added `CODEX_WORKER_MODE`, `CODEX_WORKER_STATE_DIR`, `CODEX_WORKER_SOCKET`,
  `CODEX_WORKER_CONNECT_TIMEOUT_MS`, and `CODEX_WORKER_EVENT_POLL_MS`.
- Added `CODEX_TRANSPORT=app-server-direct` as an optional direct stdio
  app-server transport using `codex app-server --stdio`.
- Added `systemd/codex-telegram-worker.service` and connected the bot service
  to it with `Wants=`/`After=`.
- Added SDK recovery stream watchdog and session backfill polling so restart
  recovery can detect missed completed output instead of timing out silently.

### Fixed

- Removed app-server daemon/proxy runtime usage, including daemon autostart and
  proxy checks. Public installs now continue to work with the default SDK
  transport without standalone app-server setup.
- Changed `bin/codex-yolo` to prefer the repository-local Codex CLI at
  `node_modules/.bin/codex` before falling back to the globally installed
  `codex` command. This keeps Telegram runtime behavior aligned with the
  package-lock version used by `@openai/codex-sdk`, instead of accidentally
  running an older global CLI after package upgrades.
- Preserved the existing `CODEX_REAL_PATH` override, so operators can still
  point the wrapper at a custom Codex executable when debugging or testing a
  specific CLI build.
- Added a regression test that executes `bin/codex-yolo --version` and compares
  it with `node_modules/.bin/codex --version`, proving the wrapper resolves to
  the package-local CLI in normal installs.
- Changed the planned restart service signal from `SIGUSR1` to `SIGUSR2`.
  Runtime smoke testing showed that sending `SIGUSR1` to the Node process
  starts the Node inspector and does not restart the bot, so the recovery
  restart path now uses
  `systemctl --user kill -s SIGUSR2 codex-telegram-bot.service`.
- Registered process signal handlers before directory setup, Telegram launch,
  and startup recovery scheduling. This reduces the window where an early
  systemd signal could hit Node's default signal behavior instead of the bot's
  planned restart handler.
- Cleared restart markers that contain no recovery candidates after startup
  planning. This prevents a planned restart with no active Codex turn from
  leaving a stale `state/recovery/restart-marker.json` behind.
- Moved startup recovery scheduling before Telegram polling launch, so restart
  markers can be inspected and cleared even when `bot.launch()` is slow to
  resolve in the service environment.
- Made direct `SIGTERM` shutdown exit explicitly after best-effort recovery
  marker flushing and Telegram stop, preventing `systemctl --user restart
  codex-telegram-bot.service` from waiting until systemd's stop timeout and
  escalating to `SIGKILL`.
- Made direct `SIGTERM` shutdown also consider persisted active-turn snapshots
  when deciding whether to write an `external_sigterm` recovery marker, so
  recovery work is preserved even if the in-memory active-turn map is not
  available during shutdown.
- Made `/recovery_cancel` clear queued recovery turns as well as the restart
  marker, while preserving normal user queue items.
- Added Telegram `/restart` redelivery dedupe using the Telegram `update_id`
  stored in recovery dedupe state, so the same delivered update cannot schedule
  the same planned restart twice.
- Added recovery failure warning tracking. When the same recovery key fails
  twice, the dedupe entry is marked with `warning: true` and the recovery
  journal records `recovery_failure_warning`.
- Added a startup recovery action planner that converts fresh startup recovery
  candidates into recovery queue turns, skips candidates whose chat is already
  active, and makes stale-marker cleanup explicit.
- Applied recovery turn thread ids to the persisted chat state before Codex
  resumes a recovery turn, and cleared mismatched cached threads so recovery
  uses the saved thread id instead of starting from the wrong cached session.
- Recorded startup recovery Telegram notice delivery as
  `recovery_startup_notice_sent` or `recovery_startup_notice_failed` in the
  recovery journal, including restart id, chat, topic, and message id metadata.
- Extracted Telegram `/restart` command handling into a focused helper so
  restart scheduling, Telegram update dedupe, scheduled replies, pending queue
  preservation, and topic notify metadata can be regression-tested without a
  live Telegram user client.
- Cleared stale restart markers when startup planning finds only stale recovery
  candidates and no fresh or suspended work remains, while recording
  `restart_marker_cleared_stale` in the recovery journal.
- Extracted direct shutdown handling so `SIGTERM` best-effort marker creation,
  ordinary no-active-turn shutdown, marker write failure logging, Telegram stop,
  and process exit are covered by focused tests.
- Suppressed stale restart marker candidates when a newer active-turn snapshot
  for the same chat/thread is no longer recovery-eligible, preventing stopped
  worker turns from spawning duplicate legacy recovery jobs after restart.
- Made worker cancellation idempotent in the Telegram runtime, so `/stop` and
  abort listeners do not send duplicate `job/cancel` RPCs for the same active
  turn.
- Treated cancelled worker recovery as stopped recovery instead of reporting a
  misleading "restart recovery failed to start" Telegram notice.
- Serialized worker job-state writes and made atomic temporary filenames unique,
  preventing duplicate event sequence numbers and `ENOENT` rename races during
  concurrent worker event writes.

### Verification

- Confirmed the local dependency tree resolves both `@openai/codex-sdk` and
  `@openai/codex` to `0.142.5` after reinstalling from `package-lock.json`.
- Confirmed `bin/codex-yolo --version` reports the same Codex CLI version as
  the package-local binary.
- Confirmed `systemctl --user kill -s SIGUSR1 codex-telegram-bot.service`
  leaves the bot PID unchanged and starts the Node inspector, so `SIGUSR1` is
  not a valid operational restart signal for this service.
- Confirmed the bootstrap signal tests cover `SIGUSR2` registration and dispatch
  through the supplied signal handler.
- Added a recovery startup test proving empty restart markers are deleted and
  recorded in the recovery journal.
- Added a recovery state test proving a `thread.started` update preserves the
  active snapshot thread id and completed turns remove the snapshot.
- Added a queue test proving recovery queue items can be removed without
  dropping normal queued user turns.
- Added a recovery dedupe test proving restart `update_id` values are persisted
  and repeated Telegram deliveries are recognized.
- Extended recovery dedupe tests to verify second-failure warning tracking and
  the matching recovery journal entry.
- Added startup recovery action tests for marker-to-recovery-turn creation,
  active-chat skipping, stale-marker cleanup, and queue ordering that keeps new
  user turns behind recovery turns during the startup gate.
- Added direct shutdown tests for active-turn `SIGTERM` marker creation,
  no-active-turn ordinary shutdown, and marker write failure logging before
  process exit.
- Added direct shutdown coverage for the persisted-snapshot SIGTERM marker
  path.
- Added a Telegram context test proving persisted pending queue metadata is
  hydrated back into topic-aware synthetic message and reply options after
  restart.
- Added restart command tests for active-turn-absent `/restart`, pending queue
  preservation during `/restart`, duplicate update suppression, and Telegram
  topic notify routing.
- Added a recovery startup test proving recovery turn thread ids are applied to
  chat state before Codex resume selection.
- Confirmed runtime smoke exposed the old direct `systemctl restart` timeout
  behavior, which is now fixed by explicit `SIGTERM` process exit.
- Confirmed the focused package binary test passes with
  `node --test test/package_bin.test.mjs`.
- Added worker protocol/store/server/executor tests, app-server-direct tests,
  config tests for sidecar defaults, recovery snapshot worker metadata tests,
  and package-bin coverage for `codex-telegram-worker`.
- Added regression tests for stale restart marker suppression after stopped
  worker turns and for serialized concurrent worker event appends.
- Confirmed `npm run verify` passes, including syntax checks, locale validation,
  ESLint, Prettier package/workflow checks, the full Node test suite, and
  `npm audit --audit-level=moderate`.
- Confirmed service-level E2E bot-only restart recovery with both a completed
  worker event log replay and a live worker job that continued through a
  running command, delivered the final Telegram reply, recorded
  `worker_recovery_completed`, removed the active snapshot, and left no restart
  marker behind.

## 1.1.6 - 2026-07-06

### Added

- Added Telegram PDF document uploads. PDF-only messages are saved under the
  configured upload directory and respond with the original filename, byte size,
  and local filesystem path without starting a Codex turn.
- Added PDF + caption support. When a PDF has a caption, the bot saves the PDF
  and runs the caption as the Codex request with the local PDF path embedded as
  text context rather than sending the PDF as an image input.
- Added replied-to PDF context. Text replies to Telegram PDF messages download
  the referenced PDF and include its local path in the Codex request while
  preserving existing replied-to image handling.
- Added recent PDF state for each chat. PDF-only uploads update the recent PDF
  record, and follow-up text that explicitly references the uploaded PDF can
  reuse that local path before the record expires.

### Changed

- Added the upload directory to Codex `additionalDirectories` automatically so
  saved PDFs remain readable even when `UPLOAD_DIR` is outside the working
  directory.
- Clarified unsupported document and message responses now that both image
  attachments and PDF documents are supported.

### Tests

- Added PDF helper tests for MIME/filename detection, PDF-only planning,
  PDF-caption planning, HTML escaping, text-only PDF references, recent PDF
  opt-in behavior, and expiry.
- Added option tests for upload directory merging and cleanup coverage for old
  PDF upload files.
- Verified the release with `npm run verify`, including syntax checks, locale
  validation, ESLint, Prettier package/workflow checks, the full Node test
  suite, and `npm audit --audit-level=moderate`.

## 1.1.5 - 2026-06-16

### Changed

- Hardened Telegram rich Markdown fallback rendering for Codex answers. When
  `sendRichMessage` is unavailable or rejected by Telegram, the HTML fallback
  now renders Markdown tables in readable mobile-safe forms instead of joining
  table cells together.
- Changed two-column Markdown table fallback output to bullet-style key/value
  blocks. This preserves the relationship between a row label and its value on
  narrow Telegram clients, avoiding collapsed output such as
  `문구실제 기능Spawn...`.
- Changed wider Markdown table fallback output to preformatted text tables so
  three-or-more-column comparisons remain aligned and scannable in Telegram
  clients that only receive the regular HTML fallback.
- Adjusted the persistent Codex answer style prompt to recommend Markdown
  tables only when they are compact and likely to fit on mobile. Longer
  explanatory comparisons now prefer bullets or short key/value sections.

### Fixed

- Fixed Markdown table collapse in the regular Telegram HTML fallback renderer.
  `markdown-it` table tokens are now handled explicitly instead of allowing
  inline table cell text to flow together with no separators.
- Preserved fenced code blocks that contain pipe-table-looking text. Tables
  inside code fences continue to render as code blocks rather than being
  transformed into fallback table output.
- Added safe observability for rich message rejection. Rich fallback decisions
  now include an error summary and warning log metadata without logging the full
  raw Markdown answer body.

### Maintenance

- Removed the empty `Unreleased` changelog heading left after the `1.1.4`
  release.

### Tests

- Added fallback renderer regression tests for two-column tables, wider tables,
  and pipe-table text inside fenced code blocks.
- Added rich message tests covering rejection summaries, safe warning logging,
  and readable HTML fallback output after rich rejection.
- Added prompt tests for the new mobile-safe table guidance.
- Verified the release with `npm run verify`, including syntax checks, locale
  validation, ESLint, Prettier package/workflow checks, the full Node test
  suite, and `npm audit --audit-level=moderate`.

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
