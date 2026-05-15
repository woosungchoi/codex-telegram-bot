<p align="center">
  <img src="assets/readme-hero.png" alt="Codex Telegram Bot hero image" width="100%">
</p>

<h1 align="center">Codex Telegram Bot</h1>

<p align="center">
  <strong>Telegram에서 Codex CLI를 제어하고, queue, inline 설정, 이미지 입력, cleanup, 안전한 유지보수 도구까지 한 번에 다룹니다.</strong>
</p>

<p align="center">
  <a href="README.md">English</a>
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

## 주요 기능

- Telegram 텍스트, reply, 사진, 이미지 문서를 Codex turn으로 실행합니다.
- Codex가 작업 중일 때 메시지를 queue에 저장하고, safe, interrupt, side-thread mode로 처리합니다.
- model, reasoning, sandbox, approval, web, language, time zone, locale, runtime override를 inline 버튼으로 설정합니다.
- raw command log나 reasoning text를 노출하지 않고 짧은 진행 알림을 보냅니다.
- keep-codex-fast에서 영감을 받은 backup-first cleanup과 로컬 유지보수 도구를 제공합니다.

안전한 로컬 상태 유지보수 도구는
[keep-codex-fast](https://github.com/vibeforge1111/keep-codex-fast)에서 영감을 받았습니다.
먼저 점검하고, 변경 전 백업하며, 삭제 대신 보관하고, 중요한 활성 thread는 정리 전에 handoff를 남기는 원칙을 따릅니다.

## 설치

```bash
cd ~/codex-telegram-bot
npm install
cp .env.example .env
```

가장 작은 시작 설정만 필요하면 아래 파일을 사용하세요.

```bash
cp .env.minimal.example .env
```

`.env`를 수정합니다.

- `TELEGRAM_BOT_TOKEN`: `@BotFather`에서 받은 Telegram bot token
- `ALLOWED_USER_IDS`: 허용할 Telegram 숫자 user id를 쉼표로 구분
- `CODEX_WORKDIR`: 기본값은 `$HOME`
- `CODEX_PATH`: Codex 실행 파일, 기본값은 `codex`. Codex가 `PATH`에 없다면 명시적으로 지정하세요.
- `CODEX_SESSIONS_DIR`: 기본값은 `$CODEX_HOME/sessions`
- `CODEX_MODELS_CACHE_FILE`: Telegram 모델 버튼에 쓰는 Codex 모델 cache, 기본값은 `$CODEX_HOME/models_cache.json`
- `CODEX_BASE_URL`, `CODEX_API_KEY`, `CODEX_CONFIG_JSON`, `CODEX_ENV_JSON`: 선택적 `Codex` SDK 생성자 설정
- `CODEX_PERSONA_PROMPT`: 모든 Codex turn 앞에 붙일 선택적 style instruction. 비워두면 `TELEGRAM_LANGUAGE`에 맞는 내장 prompt를 사용합니다.
- `TELEGRAM_REACTIONS_ENABLED`: inbound 메시지 처리 결과 reaction 사용 여부, 기본값 `true`
- `TELEGRAM_THINKING_REACTION`, `TELEGRAM_COMPLETE_REACTION`, `TELEGRAM_ERROR_REACTION`, `TELEGRAM_STOPPED_REACTION`: 처리 상태별 reaction emoji
- `TELEGRAM_FORMAT_CODEX_ANSWERS`: `markdown`은 안전한 Markdown subset을 Telegram HTML로 렌더링하고, `safe`는 code span/block만 렌더링하며, `off`는 plain text로 보냅니다.
- `TELEGRAM_LANGUAGE`: Telegram 메뉴/panel 언어와 기본 Codex 응답 언어입니다. `src/locales/*.json`에 있는 모든 언어 파일을 사용할 수 있고, 기본값은 `en`입니다. `/settings` -> `Language`에서도 바꿀 수 있습니다.
- `TELEGRAM_TIME_ZONE`: 알림, 날짜 key, timestamp에 사용할 IANA time zone, 기본값 `UTC`; `/settings` -> `Time Zone`에서도 바꿀 수 있습니다.
- `TELEGRAM_LOCALE`: 날짜/시간 표시 locale, 기본값 `en-US`; `/settings` -> `Locale`에서도 바꿀 수 있습니다.
- `TELEGRAM_COMPLETION_NOTICE_SECONDS`: 긴 Codex turn에 짧은 완료 알림을 보낼 기준 시간, 기본값 `90`, `0`이면 비활성화
- `TELEGRAM_PENDING_TURNS_MAX`: Codex 실행 중 queue에 저장할 최대 plain text/image 메시지 수, 기본값 `10`
- `TELEGRAM_PENDING_TURN_MAX_AGE_SECONDS`: queue 메시지 만료 시간, 기본값 `7200`초, `0`이면 만료 비활성화
- `TELEGRAM_LIVE_PROGRESS_ENABLED`: streamed Codex turn 실행 중 선택한 Telegram 언어로 짧은 진행 알림을 보낼지 여부, 기본값 `true`
- `TELEGRAM_LIVE_PROGRESS_INTERVAL_SECONDS`: 중요하지 않은 진행 알림의 최소 간격, 기본값 `30`
- `TELEGRAM_LIVE_PROGRESS_MODE`: 진행 알림 문구 모드, 기본값 `brief`; legacy `korean-brief`도 계속 허용됩니다.
- `TELEGRAM_LIVE_PROGRESS_SOURCE`: `agent`, `activity`, `both`; Codex comment, tool/file activity, 또는 둘 다 사용할지 선택, 기본값 `agent`
- `TELEGRAM_LIVE_PROGRESS_DELETE_POLICY`: `always`, `on_success`, `never`; 임시 진행 메시지를 언제 삭제할지 선택, 기본값 `on_success`
- `CLEANUP_ENABLED`: 매일 Codex thread cleanup 후보 알림 사용 여부, 기본값 `true`
- `CLEANUP_NOTIFY_TIME`: `TELEGRAM_TIME_ZONE` 기준 cleanup 알림 시간, 기본값 `09:00`
- `CLEANUP_RETENTION_DAYS`: 이 일수보다 오래된 session을 격리 후보로 표시, 기본값 `14`
- `CLEANUP_QUARANTINE_DAYS`: 격리 후 이 일수보다 오래된 session을 영구 삭제 후보로 표시, 기본값 `7`
- `CLEANUP_QUARANTINE_DIR`: 격리 directory, 기본값 `$CODEX_HOME/session-quarantine`
- `CLEANUP_ARTIFACT_DIR`: cleanup plan/manifest/restore artifact 저장 위치, 기본값 `./state/cleanup-artifacts`
- `CODEX_HOME`: cleanup과 maintenance에 사용할 Codex 상태 root, 기본값은 `CODEX_SESSIONS_DIR`에서 파생됩니다.
- `CODEX_MAINTENANCE_SCRIPT`: Codex maintenance Telegram 메뉴용 helper script, 기본값 `scripts/codex_maintenance.py`
- `CODEX_MAINTENANCE_BACKUP_DIR`: 유지보수 작업 backup root, 기본값 `./state/codex-maintenance`
- `CODEX_MAINTENANCE_WORKTREE_DAYS`: 오래된 worktree archive 기준 일수, 기본값 `7`
- `CODEX_MAINTENANCE_LOG_ROTATE_MB`: `logs_2.sqlite*` rotate 기준 용량, 기본값 `64`
- `CODEX_MAINTENANCE_THREAD_TITLE_LIMIT`: SQLite thread title metadata repair 제한 길이, 기본값 `120`
- `CODEX_MAINTENANCE_THREAD_PREVIEW_LIMIT`: SQLite first-message preview metadata repair 제한 길이, 기본값 `240`
- `CODEX_MAINTENANCE_AUTO_SQLITE_REPAIR_ENABLED`: daily cleanup scheduler에서 SQLite metadata repair 자동 실행 여부, 기본값 `false`
- `CODEX_MAINTENANCE_AUTO_HANDOFF_ENABLED`: daily cleanup scheduler에서 active thread handoff 자동 생성 여부, 기본값 `false`
- `CODEX_HANDOFF_DIR`: repo-local `docs/codex-handoffs` 경로를 쓸 수 없을 때 사용할 fallback handoff directory, 기본값 `$CODEX_HOME/handoffs`
- `CODEX_HANDOFF_RECENT_EVENTS`: 생성되는 handoff 문서에 포함할 최근 session highlight 수, 기본값 `40`
- `BACKUP_DIR`: 수동 backup, chat export, daily snapshot 저장 위치, 기본값 `./state/backups`
- `SNAPSHOT_ENABLED`: daily state snapshot 사용 여부, 기본값 `true`
- `SNAPSHOT_NOTIFY_TIME`: `TELEGRAM_TIME_ZONE` 기준 daily snapshot 시간, 기본값 `03:30`
- `SNAPSHOT_RETENTION_DAYS`: backup/snapshot 보관 일수, 기본값 `14`
- `LOGS_MAX_LINES`: `/logs`로 보낼 최대 줄 수, 기본값 `80`

실행합니다.

```bash
npm start
```

## GitHub 자동화

이 저장소에는 CI, Codex PR review, 실패한 CI 진단용 GitHub Actions가 포함되어 있습니다.

- `CI`: `npm ci`, `npm run check`, `npm test`, `npm run build --if-present`를 실행합니다.
- `Codex PR Review`: pull request에서 `codex review`를 실행하고 PR comment 하나를 생성/수정합니다.
- `Codex CI Diagnosis`: `CI`가 실패하면 CI log tail에 대해 `codex exec`를 실행하고, 연결된 PR이 있으면 comment를 남깁니다.
- `Codex Dependency Update`: 최신 `@openai/codex-sdk`와 `@openai/codex`를
  확인하고 설치한 뒤 `npm run check`, `npm test`, `codex --version`을 통과할
  때만 PR을 생성하거나 갱신합니다.

Codex workflow는 `OPENAI_API_KEY`를 사용하지 않습니다. Codex OAuth login용
repository secret `CODEX_ACCESS_TOKEN`이 설정된 경우에만 실행됩니다.

```bash
gh secret set CODEX_ACCESS_TOKEN --body "$CODEX_ACCESS_TOKEN"
```

secret이 설정되어 있지 않으면 Codex job은 정상적으로 skip되고 기본 CI는 계속 실행됩니다.

Dependabot도 `@openai/codex-sdk`와 `@openai/codex`는 매일, 다른 npm dependency는 매주 확인하도록 설정되어 있습니다.

## 프로젝트 문서

- [아키텍처](docs/architecture.md)
- [보안 모델](docs/security-model.md)
- [스크린샷 가이드](docs/screenshots.md)
- [번역 가이드](docs/translations.md)
- [보안 정책](SECURITY.md)
- [기여 가이드](CONTRIBUTING.md)
- [변경 내역](CHANGELOG.md)

## 번역

Telegram 메뉴 문구, 버튼 label, 명령어 설명은 `src/locales/*.json`에서
불러옵니다. 새 언어를 추가하려면 `src/locales/en.json`을 복사하고, 값을
번역한 뒤 `_meta`를 업데이트하고 아래 검증을 실행하세요.

```bash
npm run validate:locales
```

PR 체크리스트와 locale metadata 형식은 `docs/translations.md`에 정리되어 있습니다.

## Telegram 명령어

봇은 시작 시 `setMyCommands()`로 Telegram 명령어 제안을 등록합니다. Telegram에서 `/`를 입력하면 compact command menu가 열립니다. 대부분의 option command는 직접 입력해도 계속 동작하지만, visible menu는 주요 entry point 중심으로 유지됩니다.

- `/start` 또는 `/help`: 도움말 표시
- `/menu`: 메인 inline-button control panel 열기
- `/new`: 실제 새 Codex thread를 즉시 시작하고 이전/새 thread id를 표시
- `/resume [thread-id|last]`: 기존 Codex thread 이어가기. 인자가 없으면 `CODEX_SESSIONS_DIR` 아래에서 찾은 최신 session을 이어갑니다.
- `/status`: 연결된 thread와 설정 표시
- `/status`는 현재 thread log에 token count data가 있을 때 짧은 Codex usage summary도 함께 표시합니다.
- `/queue`: pause/resume, mode, clear, cancel, up, next 버튼이 있는 queue panel 표시
- `/settings`: model, thinking, fast, sandbox, approval, web search, network, stream, live progress, runtime env-style override, language, time zone, locale, path, schema 버튼 열기
- `/tools`: health, doctor, logs, config, backup, export, cleanup, forget 버튼 열기
- `/stop`: 현재 chat의 실행 중인 turn 중단

고급 직접 명령어는 Telegram의 visible menu에서는 의도적으로 숨기지만, 직접 입력하거나 자동화에서 사용할 수 있습니다.

- `/threads`: 최근 Codex thread id 목록 표시
- `/queue_pause`, `/queue_resume`: 자동 queue turn 처리를 일시정지하거나 재개
- `/queue_mode`, `/queue_mode_safe`, `/queue_mode_interrupt`, `/queue_mode_side`: Codex turn 실행 중 새 메시지를 어떻게 처리할지 확인하거나 선택
- `/cancelqueue [id|number]`: 모든 queue 메시지를 지우거나, id 또는 1-based number로 queue item 하나 제거
- `/forget`: 저장된 thread binding 제거
- `/cleanup`, `/cleanup_status`: cleanup 후보와 승인 버튼 표시
- `/backup`: bot state와 cleanup log의 redacted JSON backup을 생성하고 업로드
- `/export`: 현재 chat의 thread/options export 생성 및 업로드
- `/prefs`, `/prefs_reset`: thread를 잊지 않고 현재 chat preference를 표시하거나 초기화
- `/whoami`: Telegram user/chat id와 authorization 상태 표시
- `/logs`, `/logs_error`: token이 redaction된 최근 systemd user-service log 표시
- `/options`: chat-specific effective `ThreadOptions` 표시
- `/config`: secret 없이 process-level `Codex` constructor 설정 표시
- `/doctor`, `/health`: process, SDK, CLI, model cache, disk, state 진단 표시
- `/model [name|off]`, `/model_off`: 인자가 없으면 model 선택 버튼을 표시한 뒤 thinking 선택으로 이어짐
- `/fast`, `/fast_on`, `/fast_off`, `/fast_status`: 현재 chat의 Codex `service_tier="fast"` 설정 토글/확인
- `/workdir <absolute-dir|default>`, `/workdir_default`
- `/sandbox`, `/sandbox_read_only`, `/sandbox_workspace_write`, `/sandbox_danger_full_access`, `/sandbox_default`
- `/approval`, `/approval_never`, `/approval_on_request`, `/approval_on_failure`, `/approval_untrusted`, `/approval_default`
- `/reasoning`, `/reasoning_minimal`, `/reasoning_low`, `/reasoning_medium`, `/reasoning_high`, `/reasoning_xhigh`, `/reasoning_default`
- `/websearch`, `/websearch_disabled`, `/websearch_cached`, `/websearch_live`, `/websearch_default`
- `/network`, `/network_on`, `/network_off`, `/network_default`
- `/skipgit`, `/skipgit_on`, `/skipgit_off`, `/skipgit_default`
- `/adddir <absolute-dir>`
- `/cleardirs`
- `/stream`, `/stream_on`, `/stream_off`, `/stream_default`: SDK `runStreamed()` 또는 buffered `run()` 선택
- `/schema <json-schema|off>`, `/schema_off`: `TurnOptions.outputSchema` 설정

일반 텍스트 메시지는 현재 Codex thread로 전달됩니다. thread가 없으면 봇이 새 thread를 시작하고, Codex가 thread id를 emit한 뒤 저장합니다.

Telegram 사진과 이미지 문서는 로컬에 다운로드한 뒤 caption text와 함께 SDK `local_image` 입력으로 보냅니다.

Telegram 메시지를 reply로 보내면, reply 대상 메시지의 text/caption을 현재 요청 앞에 context로 붙입니다. reply 대상 메시지에 photo 또는 image document가 있으면 해당 이미지도 `local_image` 입력으로 함께 Codex에 전달합니다.

Codex가 inbound Telegram 메시지를 처리하는 동안 같은 chat에 추가 plain text, photo, image-document 메시지가 들어오면 기본적으로 queue에 저장되고, active turn이 끝난 뒤 순서대로 처리됩니다. Queue는 `STATE_FILE`에 저장되므로 queued text와 다운로드한 image path는 bot restart 후에도 유지됩니다. `/status`와 `/queue`는 backlog를 표시합니다. `/queue`에는 pause/resume, queue mode, clear all, cancel one item, move an item up, run an item next inline button도 표시됩니다. 직접 명령어 `/queue_pause`, `/queue_resume`, `/cancelqueue`, `/cancelqueue <id|number>`도 계속 사용할 수 있습니다.

`/queue_mode`는 Codex turn 실행 중 새 메시지가 어떻게 동작할지 정합니다.

- `safe`: 메시지를 queue에 넣고 active turn 뒤에 실행합니다. 기본값입니다.
- `interrupt`: 새 메시지를 준비해 queue 앞에 넣고 active turn을 abort한 뒤, 같은 thread에서 새 메시지를 다음 turn으로 실행합니다.
- `side`: active turn은 계속 실행하고 새 메시지는 별도 side thread에서 답변합니다. Side reply는 표시되며 main thread context와 별개로 취급해야 합니다.

`TELEGRAM_PENDING_TURN_MAX_AGE_SECONDS`보다 오래된 queued item은 자동 만료되고, 봇은 prune할 때 chat에 알립니다. "지금 뭐해?", "진행 상태?", "status" 같은 짧은 상태 질문은 queue에 들어가지 않고 즉시 답변됩니다. `/stop`은 해당 chat의 active turn, side turn, queued message를 중단합니다. Streaming이 켜져 있으면 봇은 file check, command execution, file change 같은 짧은 progress message를 선택한 Telegram 언어로 보냅니다. 이 progress message는 turn 실행 중에는 보이고, final 또는 error response가 전송된 뒤 삭제됩니다. Raw command log나 reasoning text는 stream하지 않습니다. 봇은 각 메시지가 실제로 처리될 때 reaction을 답니다. 기본 흐름은 처리 중 `🤔`, 완료 `👌`, 오류 `😢`, 중단 `😴`입니다. Live progress가 비활성화되어 있으면 긴 turn에는 `TELEGRAM_COMPLETION_NOTICE_SECONDS` 이후 compact completion notice도 전송됩니다.

`/help`, `/status`, `/options`, `/config`, `/threads`, cleanup prompt 같은 bot-owned message는 Telegram HTML formatting으로 전송됩니다. Dynamic value는 `<code>` 또는 `<pre>`로 감싸기 전에 중앙에서 escape됩니다. Free-form Codex answer는 기본적으로 `TELEGRAM_FORMAT_CODEX_ANSWERS=markdown`을 사용합니다. Markdown은 `markdown-it`으로 parse된 뒤 Telegram HTML allowlist를 통해 렌더링됩니다. 허용되는 요소는 bold, italic, strikethrough, link, blockquote, inline code, fenced code block입니다. Raw HTML은 escape되며, HTML parse failure가 발생하면 plain text로 fallback하여 malformed output 때문에 delivery가 막히지 않게 합니다.

## Runtime Overrides

`.env`는 startup default를 정의합니다. 안전한 user-facing setting은 `.env`를 직접 수정하지 않고 `/settings`에서 바꿀 수 있습니다. 이 override는 bot state에 저장되고 `Default`로 reset할 때까지 `.env`보다 우선합니다.

메뉴에서 관리할 수 있는 runtime setting:

- output: reaction, answer format, completion notice delay, maximum message length, log output line count, progress edit interval
- queue: pending turn limit, pending turn expiry
- live progress: mode와 interval, chat별 source/delete control
- cleanup: enable/disable, notify time, retention, quarantine, approval TTL
- snapshots: enable/disable, notify time, retention
- UI: language, time zone, locale

Secret, token, 절대경로, process-level Codex SDK constructor value는 계속 `.env`에 두고 service restart로 반영해야 합니다.

## Session Cleanup

봇은 `TELEGRAM_TIME_ZONE` 기준 `CLEANUP_NOTIFY_TIME` 이후 하루에 한 번 cleanup reminder를 보냅니다.
이 단계에서는 approval plan만 만들며, Telegram inline button을 누르기 전에는 파일을 이동하거나 삭제하지 않습니다.

기본 정책:

- Telegram에 연결된 active thread와 현재 실행 중인 Codex thread id는 보호됩니다.
- `CLEANUP_RETENTION_DAYS`보다 오래된 session log는 quarantine 후보가 됩니다.
- Quarantine된 log 중 `CLEANUP_QUARANTINE_DAYS`보다 오래된 log는 permanent delete 후보가 됩니다.
- Approval plan은 `CLEANUP_PLAN_TTL_HOURS` 뒤 만료됩니다.

수동 검토는 `/cleanup`으로 할 수 있습니다.

`/tools` panel에는 keep-codex-fast-style maintenance를 위한 `Codex Maintenance`도 포함됩니다. Report action은 read-only입니다. Backup, config prune, worktree archive, log rotate는 backup-first로 동작하고 permanent deletion을 피합니다. SQLite metadata repair는 별도의 명시적 버튼입니다. 먼저 백업하고, thread-list title/preview metadata만 짧게 줄이며, session JSONL transcript는 그대로 둡니다. Active thread handoff 생성도 버튼으로 사용할 수 있고, 가능하면 repo-local `docs/codex-handoffs` draft를 작성합니다. Automatic repair와 automatic handoff generation은 모두 기본적으로 off입니다. Telegram maintenance menu에서 이 automatic option을 runtime에 toggle할 수 있으며, 저장된 state는 첫 startup에서 environment value를 기본값으로 사용합니다.

## systemd User Service

```bash
mkdir -p ~/.config/systemd/user
cp ~/codex-telegram-bot/systemd/codex-telegram-bot.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now codex-telegram-bot.service
systemctl --user status codex-telegram-bot.service
```

로그 확인:

```bash
journalctl --user -u codex-telegram-bot.service -f
```

## 라이선스

MIT 라이선스입니다. 자세한 내용은 [LICENSE](LICENSE)를 확인하세요.
