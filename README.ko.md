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
- 끊긴 streamed turn은 다시 실행하기 전에 Codex session log를 확인해 완료 답변을 회수합니다.
- keep-codex-fast에서 영감을 받은 backup-first cleanup과 로컬 유지보수 도구를 제공합니다.

안전한 로컬 상태 유지보수 도구는
[keep-codex-fast](https://github.com/vibeforge1111/keep-codex-fast)에서 영감을 받았습니다.
먼저 점검하고, 변경 전 백업하며, 삭제 대신 보관하고, 중요한 활성 thread는 정리 전에 handoff를 남기는 원칙을 따릅니다.

## 설치

로컬 clone에서 실행하려면:

```bash
cd ~/codex-telegram-bot
npm install
cp .env.example .env
chmod 600 .env
```

현재 디렉터리에 `.env`를 만든 뒤에는 clone을 보관하지 않고 package command로 실행할 수도 있습니다.

```bash
npx --yes --package github:woosungchoi/codex-telegram-bot codex-telegram-bot
```

반복해서 사용할 때는 command를 global install할 수 있습니다.

```bash
npm install --global github:woosungchoi/codex-telegram-bot
codex-telegram-bot
```

가장 작은 시작 설정만 필요하면 아래 파일을 사용하세요.

```bash
cp .env.minimal.example .env
chmod 600 .env
```

`.env`에는 credential이 있으므로 owner-only로 유지해야 합니다. Runtime state에는
chat/thread metadata, queue, upload, recovery 기록, backup이 포함될 수 있으므로 bot도
민감한 state file을 `0600`, 해당 directory를 `0700`으로 생성합니다.

`.env`를 수정합니다.

- `TELEGRAM_BOT_TOKEN`: `@BotFather`에서 받은 Telegram bot token
- `ALLOWED_USER_IDS`: 허용할 양수 Telegram numeric user id를 쉼표로 구분
- `ALLOWED_CHAT_IDS`: 선택값. numeric chat id를 쉼표로 구분합니다. group/supergroup의 음수 chat id도 허용됩니다. 설정하면 해당 chat id에서만 허용됩니다.
- `ALLOWED_THREAD_IDS`: 선택값. 양수 forum topic/thread id를 쉼표로 구분합니다. 설정하면 해당 forum topic/thread id에서만 허용됩니다.
- `CODEX_WORKDIR`: 기본값은 `$HOME`
- `CODEX_PATH`: Codex 실행 파일, 기본값은 `codex`. Codex가 `PATH`에 없다면 명시적으로 지정하세요.
- `CODEX_TRANSPORT`: `sdk` 또는 `app-server-direct`, 기본값 `sdk`. 일반 설치는 `sdk`를 권장합니다. `app-server-direct`는 설치된 Codex CLI가 direct `app-server --stdio`를 지원할 때만 사용하세요.
- `CODEX_WORKER_MODE`: `sidecar` 또는 `inline`, 기본값 `sidecar`. `sidecar`는 Codex turn을 `codex-telegram-worker`에서 실행하고, `inline`은 기존 단일 프로세스 fallback입니다.
- `CODEX_WORKER_STATE_DIR`: worker job state와 event log 디렉터리, 기본값 `./state/worker`
- `CODEX_WORKER_SOCKET`: bot이 worker와 통신하는 Unix socket, 기본값 `CODEX_WORKER_STATE_DIR/worker.sock`
- `CODEX_WORKER_CONNECT_TIMEOUT_MS`: worker RPC timeout, 기본값 `5000`
- `CODEX_WORKER_EVENT_POLL_MS`: bot이 worker job event를 확인하는 간격, 기본값 `1000`
- `CODEX_APP_SERVER_DIRECT_TIMEOUT_MS`: 선택적 direct app-server 요청 timeout, 기본값 `5000`
- `CODEX_SESSIONS_DIR`: 기본값은 `$CODEX_HOME/sessions`
- `CODEX_MODELS_CACHE_FILE`: Telegram 모델 버튼에 쓰는 Codex 모델 cache, 기본값은 `$CODEX_HOME/models_cache.json`
- `CODEX_MODEL`: global 기본 model입니다. Global `CODEX_REASONING_EFFORT`는 global `CODEX_MODEL`이 지원하는 값이어야 하며, Telegram은 알려진 per-chat model/effort 조합을 현재 Codex catalog capability에 맞춰 검증합니다.
- `CODEX_REASONING_EFFORT`: global 기본 reasoning effort입니다. 현재 Codex catalog capability가 picker option을 결정하며, Telegram은 선택된 알려진 모델이 알리지 않은 effort를 거부합니다. Max (`max`)는 단일 작업을 깊게 추론합니다. Ultra (`ultra`)는 자동 위임을 활성화하며 catalog가 알릴 때만 표시됩니다. 높은 effort는 latency와 usage를 늘릴 수 있습니다.
- `CODEX_BASE_URL`, `CODEX_API_KEY`, `CODEX_CONFIG_JSON`, `CODEX_ENV_JSON`: 선택적 `Codex` SDK 생성자 설정
- `CODEX_MODEL_CONTEXT_WINDOW`: 선택적 raw Codex `model_context_window` override입니다. 일반 OpenAI/Codex 사용자는 이 값과 `CODEX_AUTO_COMPACT_TOKEN_LIMIT`을 비워 두어 model 변경 시 native context 및 automatic-compaction limit을 사용해야 합니다. Custom provider나 특수 deployment에서 명시하면 Codex가 model의 effective-window percentage를 적용하기 전에 raw catalog context를 대체합니다. `CODEX_CONTEXT_COMPACT_THRESHOLD_PERCENT`와 함께 설정하면 bot이 `model_auto_compact_token_limit`을 계산합니다.
- `CODEX_AUTO_COMPACT_TOKEN_LIMIT`: 선택적 Codex `model_auto_compact_token_limit` override입니다. 비워 두면 native per-model threshold를 사용하며, custom provider나 특수 deployment에서 명시한 값은 해당 threshold를 직접 대체합니다.
- `CODEX_TOOL_OUTPUT_TOKEN_LIMIT`: 저장되는 tool output 압박을 줄이기 위한 선택적 Codex `tool_output_token_limit` override입니다.
- `CODEX_COMPACT_STRENGTH`: compact prompt 강도입니다. `default`, `light`, `balanced`, `aggressive` 중 하나이며, `default`는 Codex 기본 compact prompt를 유지합니다.
- `CODEX_COMPACT_PROMPT_FILE`: 선택적 Codex `experimental_compact_prompt_file` 경로입니다. 설정하면 `CODEX_COMPACT_STRENGTH`보다 우선합니다.
- `CODEX_CONTEXT_GUARD_ENABLED`: 연결된 thread가 context 임계치에 가까우면 Telegram에 짧은 안내를 보냅니다. 기본값은 `true`
- `CODEX_CONTEXT_COMPACT_THRESHOLD_PERCENT`: guard 안내 기준이자 `CODEX_MODEL_CONTEXT_WINDOW`가 있을 때 `CODEX_AUTO_COMPACT_TOKEN_LIMIT` 계산에 쓰는 context 사용률입니다. 기본값은 `75`
- `CODEX_CONTEXT_MIN_REMAINING_TOKENS`: 현재 thread의 남은 토큰이 이 값 이하일 때도 안내합니다. 기본값은 `40000`
- `CODEX_SKIP_GIT_REPO_CHECK`: Git 저장소 밖 Codex turn 허용 여부. 기본값은 `false`이며 명시적으로 필요할 때만 `true`로 설정하세요.
- `CODEX_PERSONA_PROMPT`: 모든 Codex turn 앞에 붙일 선택적 style instruction. 비워두면 `TELEGRAM_LANGUAGE`에 맞는 내장 prompt를 사용합니다. 선택한 언어의 Telegram rich Markdown 서식 지침은 항상 함께 추가됩니다.
- `TELEGRAM_REACTIONS_ENABLED`: inbound 메시지 처리 결과 reaction 사용 여부, 기본값 `true`
- `TELEGRAM_THINKING_REACTION`, `TELEGRAM_COMPLETE_REACTION`, `TELEGRAM_ERROR_REACTION`, `TELEGRAM_STOPPED_REACTION`: 처리 상태별 reaction emoji
- `TELEGRAM_FORMAT_CODEX_ANSWERS`: `markdown`은 Codex 답변을 Telegram rich Markdown으로 먼저 보내고 실패 시 안전한 Telegram HTML로 fallback하며, `safe`는 code span/block만 렌더링하고, `off`는 plain text로 보냅니다.
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
- `CLEANUP_NOTIFY_CHAT_IDS`: 선택값. daily cleanup 알림을 보낼 numeric chat id 목록. group/supergroup의 음수 chat id도 허용됩니다.
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
- `BOT_RESTART_RECOVERY_ENABLED`: restart recovery marker, startup recovery, manual recovery control 사용 여부, 기본값 `true`
- `BOT_RESTART_EXIT_CODE`: planned self-restart에서 사용할 exit code, 기본값 `75`
- `BOT_RESTART_DRAIN_TIMEOUT_SECONDS`: recovery marker 작성 후 planned restart가 종료되기 전 최대 대기 시간, 기본값 `900`
- `BOT_RESTART_DELAY_SECONDS`: restart 요청 후 process exit까지 지연 시간, 기본값 `3`
- `BOT_RECOVERY_DIR`: recovery marker/journal 디렉터리, 기본값 `./state/recovery`
- `BOT_RECOVERY_STALE_SECONDS`: startup 자동 recovery 후보의 최대 age, 기본값 `21600`
- `BOT_RECOVERY_TURN_TTL_SECONDS`: recovery queue item TTL, 기본값 `86400`
- `BOT_RECOVERY_SUSPEND_AFTER`: 같은 recovery key 자동 복구를 suspend할 attempt 수, 기본값 `3`
- `BOT_RECOVERY_BACKFILL_POLL_MS`: startup recovery turn 중 Codex session backfill을 확인할 간격, 기본값 `30000`; `0`이면 비활성화
- `CODEX_STREAM_IDLE_NOTICE_MS`: recovery 안내를 보내기 전 stream idle 시간, 기본값 `120000`
- `CODEX_STREAM_IDLE_ABORT_MS`: SDK turn을 중단하기 전 stream idle 시간, 기본값 `900000`
- `UPLOAD_DIR`: Codex로 보내기 전에 다운로드한 Telegram 이미지 입력 저장 위치, 기본값 `./state/uploads`
- `UPLOAD_RETENTION_DAYS`: 이 일수보다 오래된 이미지 upload를 upload cleanup 후보로 표시, 기본값 `7`
- `UPLOAD_MAX_BYTES`: upload directory 용량 목표이자 파일별 다운로드 상한 byte, 기본값 `1073741824`, `0`이면 용량 목표와 다운로드 상한 비활성화
- `UPLOAD_CLEANUP_ENABLED`: daily cleanup scheduler에서 upload cleanup dry-run plan 기록 여부, 기본값 `true`
- `BACKUP_DIR`: 수동 backup, chat export, daily snapshot 저장 위치, 기본값 `./state/backups`
- `SNAPSHOT_ENABLED`: daily state snapshot 사용 여부, 기본값 `true`
- `SNAPSHOT_NOTIFY_TIME`: `TELEGRAM_TIME_ZONE` 기준 daily snapshot 시간, 기본값 `03:30`
- `SNAPSHOT_RETENTION_DAYS`: backup/snapshot 보관 일수, 기본값 `14`
- `LOGS_MAX_LINES`: `/logs`로 보낼 최대 줄 수, 기본값 `80`

sidecar 모드에서는 두 프로세스를 실행합니다.

```bash
npm run start:worker
npm start
```

로컬에서 release 수준 검증을 실행하려면:

```bash
npm run verify
```

## Codex Worker, Transport, Recovery

기본 런타임은 `CODEX_WORKER_MODE=sidecar`와 `CODEX_TRANSPORT=sdk`입니다.
이 모드에서는 `codex-telegram-worker`가 Codex turn 실행을 소유하고,
job별 JSONL event log를 영속적으로 기록합니다. Telegram bot은 Telegram update,
메뉴, 응답 전송, delivery cursor만 담당합니다.

이 분리가 bot 재시작 복구의 핵심입니다. `codex-telegram-bot.service`가 turn
실행 중 재시작되어도 worker는 Codex stream을 계속 유지합니다. bot은 startup
후 worker에 다시 연결해 저장된 cursor 이후 event를 재생하고 final answer 또는
failure message를 전송합니다. Sidecar job이 이미 완료됐다면 영속 event log에서
결과를 재구성하며 Codex turn을 다시 실행하지 않습니다.

Final answer 전달 상태는 별도로 영속화합니다. 준비됐지만 아직 전송을 시작하지
않은 것으로 확인된 결과만 restart 후 안전하게 재전송할 수 있습니다. Telegram
요청을 시작한 뒤 timeout이 발생하면 실제 전달 여부가 불확실합니다. Telegram
`sendMessage`에는 idempotency key가 없으므로, bot은 중복 답변을 피하기 위해 이
상태를 보존하고 자동 재전송하지 않습니다.

SDK stream backfill은 inline 및 worker 소유가 아닌 recovery의 fallback으로 계속
유지됩니다. `CODEX_SESSIONS_DIR`의 해당 rollout JSONL에서 agent message와
`task_complete`를 확인할 수 있습니다. Worker 소유 snapshot은 worker에 연결할 수
없더라도 새 Codex turn으로 넘어가지 않고 상태를 보존하므로 중복 작업을 시작하지
않습니다.

`CODEX_WORKER_MODE=inline`은 개발/비상 fallback입니다. inline 모드에서는 bot이
Codex를 직접 실행하므로 bot process가 재시작되면 active stream도 함께 끊깁니다.

`CODEX_TRANSPORT=app-server-direct`는 선택 기능입니다. worker가 아래 direct stdio
child process를 시작합니다.

```bash
codex app-server --stdio
```

app-server daemon, daemon autostart, daemon version check, proxy process는 더 이상
사용하지 않습니다. 공개 설치의 기본 `sdk` transport는 일반 Codex CLI/SDK 경로만
필요합니다. `app-server-direct`는 설치된 Codex CLI가 호환되는 direct stdio
app-server를 제공할 때만 사용하세요.

Telegram 조작 경로:

- `/settings` -> `Runtime` -> `Codex`를 엽니다.
- worker mode를 `sidecar`, `inline`, `Default` 중에서 선택합니다.
- transport를 `SDK`, `app-server direct`, `Default` 중에서 선택합니다.
- `Test worker`로 sidecar socket을 확인합니다.
- `Test app-server direct`로 direct app-server CLI 지원 여부를 확인합니다.
- worker mode나 transport를 바꾼 뒤 `Save & restart`로 반영합니다.

## GitHub 자동화

이 저장소에는 CI, Codex PR review, 실패한 CI 진단용 GitHub Actions가 포함되어 있습니다.

- `CI`: `npm ci`, `npm run verify`, `actionlint`, `npm pack --dry-run --json`, `npm run build --if-present`를 실행합니다.
- `Codex PR Review`: Codex OAuth login이 가능할 때 pull request에서 `codex review`를 실행하고 PR comment 하나를 생성/수정합니다.
- `Codex CI Diagnosis`: `CI`가 실패하면 GitHub Actions metadata, 실패 job/step, 실패 log excerpt 기반의 deterministic 기본 진단을 항상 남깁니다. Codex OAuth login이 가능할 때만 optional AI 추가 진단을 append합니다.
- `Codex Dependency Update`: 최신 `@openai/codex-sdk`와 `@openai/codex`를
  확인하고 설치한 뒤 `npm run check`, `npm test`, `codex --version`을 통과할
  때만 PR을 생성하거나 갱신합니다.

Codex workflow는 `OPENAI_API_KEY`를 사용하지 않습니다. `CODEX_ACCESS_TOKEN`은 선택 사항입니다.
`Codex PR Review`와 `Codex CI Diagnosis`의 AI 추가 진단만 Codex OAuth login용
repository secret이 설정된 경우에 실행됩니다.

```bash
gh secret set CODEX_ACCESS_TOKEN --body "$CODEX_ACCESS_TOKEN"
```

secret이 설정되어 있지 않거나 만료되어도 Codex AI 단계만 정상적으로 skip됩니다. 기본 CI,
deterministic CI 진단, dependency update, auto-merge safety check는 계속 실행됩니다.

Dependabot도 `@openai/codex-sdk`와 `@openai/codex`는 매일, 다른 npm dependency는 매주 확인하도록 설정되어 있습니다.

## 프로젝트 문서

- [아키텍처](docs/architecture.md)
- [보안 모델](docs/security-model.md)
- [릴리스 체크리스트](docs/release-checklist.md)
- [롤백](docs/rollback.md)
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
- `/status`는 현재 thread log에 token count data가 있을 때 짧은 Codex usage summary, sample age를 표시하고, reset이 지난 limit은 오래된 percent를 현재값처럼 표시하지 않고 stale로 표시합니다. `사용량 새로 조회` 버튼은 별도 Codex probe turn을 작게 실행해 더 최신 usage sample을 가져올 수 있으며, 소량의 quota를 사용할 수 있습니다.
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
- `/cleanup_uploads`, `/cleanup_uploads_confirm`: 오래된 다운로드 Telegram 이미지 입력을 preview하며, 삭제는 inline confirm 버튼으로만 실행
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
- `/reasoning`, `/reasoning_minimal`, `/reasoning_low`, `/reasoning_medium`, `/reasoning_high`, `/reasoning_xhigh`, `/reasoning_default`: reasoning picker를 열거나 effort를 설정 또는 reset합니다. `/reasoning max`와 `/reasoning ultra`는 현재 catalog가 선택한 모델에 알린 경우에만 해당 effort를 선택하며, Telegram은 선택한 알려진 모델이 지원하지 않는 effort를 거부합니다.
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

Codex 실행은 완료됐지만 final Telegram reply가 pending이거나 전달 결과가 불확실하면 같은 chat의 새 메시지는 기존 영속 queue에 대기합니다. `/status`와 `/queue`는 Codex 실행과 final delivery를 구분하고, 안전한 재전송 가능 여부 또는 중복 방지를 위한 자동 재전송 비활성 상태를 표시합니다.

`/queue_mode`는 Codex turn 실행 중 새 메시지가 어떻게 동작할지 정합니다.

- `safe`: 메시지를 queue에 넣고 active turn 뒤에 실행합니다. 기본값입니다.
- `interrupt`: 새 메시지를 준비해 queue 앞에 넣고 active turn을 abort한 뒤, 같은 thread에서 새 메시지를 다음 turn으로 실행합니다.
- `side`: active turn은 계속 실행하고 새 메시지는 별도 side thread에서 답변합니다. Side reply는 표시되며 main thread context와 별개로 취급해야 합니다.

`TELEGRAM_PENDING_TURN_MAX_AGE_SECONDS`보다 오래된 queued item은 자동 만료되고, 봇은 prune할 때 chat에 알립니다. "지금 뭐해?", "진행 상태?", "status" 같은 짧은 상태 질문은 queue에 들어가지 않고 즉시 답변됩니다. `/stop`은 해당 chat의 active turn, side turn, queued message를 중단합니다. Streaming이 켜져 있으면 봇은 file check, command execution, file change 같은 짧은 progress message를 선택한 Telegram 언어로 보냅니다. 이 progress message는 turn 실행 중에는 보이고, final 또는 error response가 전송된 뒤 삭제됩니다. Raw command log나 reasoning text는 stream하지 않습니다. Progress message 전송 실패는 기록하지만 Codex 실행이나 worker event 소비를 중단하지 않습니다. 봇은 각 메시지가 실제로 처리될 때 reaction을 답니다. 기본 흐름은 처리 중 `🤔`, 완료 `👌`, 오류 `😢`, 중단 `😴`입니다. Live progress가 비활성화되어 있으면 긴 turn에는 `TELEGRAM_COMPLETION_NOTICE_SECONDS` 이후 compact completion notice도 전송됩니다.

`/help`, `/status`, `/options`, `/config`, `/threads`, cleanup prompt 같은 bot-owned message는 Telegram HTML formatting으로 전송됩니다. Dynamic value는 `<code>` 또는 `<pre>`로 감싸기 전에 중앙에서 escape됩니다. Free-form Codex answer는 기본적으로 `TELEGRAM_FORMAT_CODEX_ANSWERS=markdown`을 사용합니다. 모든 Codex turn에는 선택한 언어의 내장 지침이 함께 들어가서 제목, 표, list, preformatted code block, 구분자, bold, inline code, fenced code block을 필요할 때 적극 활용하도록 요청합니다. 이 서식 지침은 `CODEX_PERSONA_PROMPT`로 기본 말투를 override해도 계속 추가되며, 사용자가 명시한 다른 형식 요청이 있으면 그 요청을 우선합니다. Markdown mode는 raw answer Markdown을 Telegram rich message로 먼저 보내므로 table, divider, heading, list, bold/italic, inline code, fenced code block이 Telegram native rich formatting으로 표시될 수 있습니다. 한 줄 전체가 짧은 inline code 하나인 경우에는 Telegram이 배경 있는 compact block으로 렌더링할 수 있도록 1줄 rich code block으로 승격합니다. Rich message를 사용할 수 없거나 거부되면 기존 Telegram HTML renderer로 fallback합니다. Fallback 경로에서는 raw HTML을 escape하고, HTML parse failure가 발생하면 plain text로 fallback하여 malformed output 때문에 delivery가 막히지 않게 합니다.

## Runtime Overrides

`.env`는 startup default를 정의합니다. 안전한 user-facing setting은 `.env`를 직접 수정하지 않고 `/settings`에서 바꿀 수 있습니다. 이 override는 bot state에 저장되고 `Default`로 reset할 때까지 `.env`보다 우선합니다.

메뉴에서 관리할 수 있는 runtime setting:

- output: reaction, answer format, completion notice delay, maximum message length, log output line count, progress edit interval
- queue: pending turn limit, pending turn expiry
- Codex: worker mode, worker poll interval, transport, app-server direct timeout, worker/app-server status check, save-and-restart
- live progress: mode와 interval, chat별 source/delete control
- cleanup: enable/disable, notify time, retention, quarantine, approval TTL
- snapshots: enable/disable, notify time, retention
- UI: language, time zone, locale

Secret, token, 절대경로, process-level Codex constructor value는 계속 `.env`에 둡니다.
Worker mode와 transport 변경은 bot state에 저장되지만, 변경 후에는 running
service를 restart해 반영하는 것을 권장합니다.

## Session Cleanup

봇은 `TELEGRAM_TIME_ZONE` 기준 `CLEANUP_NOTIFY_TIME` 이후 하루에 한 번 cleanup reminder를 보냅니다.
이 단계에서는 approval plan만 만들며, Telegram inline button을 누르기 전에는 파일을 이동하거나 삭제하지 않습니다.

기본 정책:

- Telegram에 연결된 active thread와 현재 실행 중인 Codex thread id는 보호됩니다.
- `CLEANUP_RETENTION_DAYS`보다 오래된 session log는 quarantine 후보가 됩니다.
- Quarantine된 log 중 `CLEANUP_QUARANTINE_DAYS`보다 오래된 log는 permanent delete 후보가 됩니다.
- Approval plan은 `CLEANUP_PLAN_TTL_HOURS` 뒤 만료됩니다.

수동 검토는 `/cleanup`으로 할 수 있습니다.

다운로드한 Telegram 이미지 입력은 Codex로 보내기 전에 `UPLOAD_DIR` 아래에 저장됩니다.
`/cleanup_uploads`는 `UPLOAD_RETENTION_DAYS`보다 오래되었거나 `UPLOAD_MAX_BYTES` 아래로 줄이기 위해 선택된 파일을 미리 보여주며, 실제 삭제는 inline `Confirm upload cleanup` 버튼을 누를 때만 실행됩니다. 기존 `/cleanup_uploads_confirm` typed command는 `/cleanup_uploads` 안내만 하고 파일을 삭제하지 않습니다.

`/tools` panel에는 keep-codex-fast-style maintenance를 위한 `Codex Maintenance`도 포함됩니다. Report action은 read-only입니다. Backup, config prune, worktree archive, log rotate는 backup-first로 동작하고 permanent deletion을 피합니다. SQLite metadata repair는 별도의 명시적 버튼입니다. 먼저 백업하고, thread-list title/preview metadata만 짧게 줄이며, session JSONL transcript는 그대로 둡니다. Active thread handoff 생성도 버튼으로 사용할 수 있고, 가능하면 repo-local `docs/codex-handoffs` draft를 작성합니다. Automatic repair와 automatic handoff generation은 모두 기본적으로 off입니다. Telegram maintenance menu에서 이 automatic option을 runtime에 toggle할 수 있으며, 저장된 state는 첫 startup에서 environment value를 기본값으로 사용합니다.

## systemd User Service

기본 경로를 쓰는 기존 설치는 아래 1회 권한 교정 전에 service를 중지하세요.
`find -P`는 symlink를 따라가지 않습니다. Symlink는 별도로 검토하고, 사용자 관리
파일이 섞일 수 있는 custom state path에 이 재귀 명령을 무차별 적용하지 마세요.

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

설치된 unit을 갱신한 뒤에는 최신 unit 파일 두 개를 다시 복사하고
`systemctl --user daemon-reload`를 실행한 다음 worker, bot 순서로 재시작해야
effective `UMask=0077`이 적용됩니다.

```bash
systemctl --user daemon-reload
systemctl --user restart codex-telegram-worker.service
systemctl --user restart codex-telegram-bot.service
```

로그 확인:

```bash
journalctl --user -u codex-telegram-worker.service -f
journalctl --user -u codex-telegram-bot.service -f
```

## 라이선스

MIT 라이선스입니다. 자세한 내용은 [LICENSE](LICENSE)를 확인하세요.
