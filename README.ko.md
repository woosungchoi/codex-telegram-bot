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

`.env`를 수정합니다.

- `TELEGRAM_BOT_TOKEN`: `@BotFather`에서 받은 Telegram bot token
- `ALLOWED_USER_IDS`: 허용할 Telegram 숫자 user id를 쉼표로 구분
- `CODEX_WORKDIR`: 기본값은 `$HOME`
- `CODEX_PATH`: Codex 실행 파일, 기본값은 `codex`
- `CODEX_SESSIONS_DIR`: 기본값은 `$CODEX_HOME/sessions`
- `CODEX_MODELS_CACHE_FILE`: Telegram 모델 버튼에 쓰는 Codex 모델 cache, 기본값은 `$CODEX_HOME/models_cache.json`
- `CODEX_BASE_URL`, `CODEX_API_KEY`, `CODEX_CONFIG_JSON`, `CODEX_ENV_JSON`: 선택적 Codex SDK 생성자 설정
- `CODEX_PERSONA_PROMPT`: 모든 Codex turn 앞에 붙일 선택적 style instruction. 비워두면 `TELEGRAM_LANGUAGE`에 맞는 내장 prompt를 사용합니다.
- `TELEGRAM_LANGUAGE`: Telegram 메뉴와 기본 Codex 응답 언어, `en` 또는 `ko`, 기본값 `en`
- `TELEGRAM_TIME_ZONE`: 알림, 날짜 key, timestamp에 사용할 IANA time zone, 기본값 `UTC`
- `TELEGRAM_LOCALE`: 날짜/시간 표시 locale, 기본값 `en-US`
- `TELEGRAM_FORMAT_CODEX_ANSWERS`: `markdown`, `safe`, `off`
- `TELEGRAM_REACTIONS_ENABLED`: 처리 상태 reaction 사용 여부, 기본값 `true`
- `TELEGRAM_PENDING_TURNS_MAX`: Codex 실행 중 queue에 저장할 최대 메시지 수, 기본값 `10`
- `TELEGRAM_PENDING_TURN_MAX_AGE_SECONDS`: queue 메시지 만료 시간, 기본값 `7200`
- `TELEGRAM_LIVE_PROGRESS_ENABLED`: Codex 실행 중 짧은 진행 알림을 보낼지 여부, 기본값 `true`
- `TELEGRAM_LIVE_PROGRESS_INTERVAL_SECONDS`: 중요하지 않은 진행 알림의 최소 간격, 기본값 `30`
- `TELEGRAM_LIVE_PROGRESS_SOURCE`: `agent`, `activity`, `both`
- `TELEGRAM_LIVE_PROGRESS_DELETE_POLICY`: `always`, `on_success`, `never`
- `CLEANUP_ENABLED`: 매일 Codex thread cleanup 후보 알림 사용 여부, 기본값 `true`
- `CLEANUP_NOTIFY_TIME`: `TELEGRAM_TIME_ZONE` 기준 cleanup 알림 시간, 기본값 `09:00`
- `CLEANUP_RETENTION_DAYS`: 이 일수보다 오래된 session을 격리 후보로 표시, 기본값 `14`
- `CLEANUP_QUARANTINE_DAYS`: 격리 후 이 일수보다 오래된 session을 영구 삭제 후보로 표시, 기본값 `7`
- `CODEX_HOME`: Codex 상태 root. 기본값은 `CODEX_SESSIONS_DIR`에서 파생됩니다.
- `CODEX_MAINTENANCE_SCRIPT`: 유지보수 helper script, 기본값 `scripts/codex_maintenance.py`
- `CODEX_MAINTENANCE_BACKUP_DIR`: 유지보수 작업 backup root, 기본값 `./state/codex-maintenance`
- `CODEX_MAINTENANCE_AUTO_SQLITE_REPAIR_ENABLED`: daily cleanup scheduler에서 SQLite metadata repair 자동 실행 여부, 기본값 `false`
- `CODEX_MAINTENANCE_AUTO_HANDOFF_ENABLED`: daily cleanup scheduler에서 active thread handoff 자동 생성 여부, 기본값 `false`
- `BACKUP_DIR`: 수동 backup, chat export, daily snapshot 저장 위치, 기본값 `./state/backups`
- `SNAPSHOT_ENABLED`: daily state snapshot 사용 여부, 기본값 `true`
- `SNAPSHOT_NOTIFY_TIME`: `TELEGRAM_TIME_ZONE` 기준 snapshot 시간, 기본값 `03:30`
- `SNAPSHOT_RETENTION_DAYS`: backup/snapshot 보관 일수, 기본값 `14`
- `LOGS_MAX_LINES`: `/logs`로 보낼 최대 줄 수, 기본값 `80`

실행합니다.

```bash
npm start
```

## GitHub 자동화

이 저장소에는 CI, Codex PR review, 실패한 CI 진단용 GitHub Actions가 포함되어 있습니다.

- `CI`: `npm ci`, `npm run check`, `npm test --if-present`, `npm run build --if-present` 실행
- `Codex PR Review`: pull request에서 `codex review` 실행 후 PR comment 하나를 생성/수정
- `Codex CI Diagnosis`: `CI` 실패 시 CI log tail을 `codex exec`로 진단하고 PR이 있으면 comment 생성

Codex workflow는 `OPENAI_API_KEY`를 사용하지 않습니다. Codex OAuth login용
repository secret `CODEX_ACCESS_TOKEN`이 있을 때만 실행됩니다.

```bash
gh secret set CODEX_ACCESS_TOKEN --body "$CODEX_ACCESS_TOKEN"
```

secret이 없으면 Codex job은 정상적으로 skip되고 기본 CI만 실행됩니다.

## Telegram 명령어

봇은 시작 시 `setMyCommands()`로 Telegram 명령어 제안을 등록합니다. Telegram에서 `/`를 입력하면 핵심 메뉴가 보입니다.

- `/start` 또는 `/help`: 도움말 표시
- `/menu`: 메인 inline button control panel 열기
- `/new`: 새 Codex thread 시작
- `/resume [thread-id|last]`: 기존 Codex thread 이어가기
- `/status`: 연결된 thread와 설정 표시
- `/queue`: pause/resume, mode, clear, cancel, up, next 버튼이 있는 queue panel 표시
- `/settings`: model, thinking, sandbox, approval, web search, network, stream, live progress, runtime override, language, time zone, locale, path, schema 설정
- `/tools`: health, doctor, logs, config, backup, export, cleanup, forget 도구
- `/stop`: 현재 chat의 실행 중인 turn 중단

고급 명령어는 Telegram의 visible menu에서는 숨기지만 직접 입력하면 사용할 수 있습니다.

- `/threads`
- `/queue_pause`, `/queue_resume`
- `/queue_mode`, `/queue_mode_safe`, `/queue_mode_interrupt`, `/queue_mode_side`
- `/cancelqueue [id|number]`
- `/forget`
- `/cleanup`, `/cleanup_status`
- `/backup`, `/export`
- `/prefs`, `/prefs_reset`
- `/whoami`
- `/logs`, `/logs_error`
- `/options`, `/config`
- `/doctor`, `/health`
- `/model`, `/reasoning`, `/sandbox`, `/approval`
- `/websearch`, `/network`, `/skipgit`
- `/workdir`, `/adddir`, `/cleardirs`
- `/stream`, `/schema`

일반 텍스트 메시지는 현재 Codex thread로 전달됩니다. thread가 없으면 새로 시작하고, Codex가 thread id를 반환하면 저장합니다.

Telegram 사진과 이미지 문서는 로컬에 다운로드한 뒤 caption text와 함께 SDK `local_image` 입력으로 보냅니다.

Telegram reply로 메시지를 보내면, reply 대상 메시지의 text/caption을 현재 요청 앞에 context로 붙입니다. reply 대상에 이미지가 있으면 해당 이미지도 같이 전달합니다.

Codex가 처리 중일 때 들어온 추가 메시지는 기본적으로 같은 chat queue에 저장되고, 현재 turn이 끝난 뒤 순서대로 처리됩니다. queue는 `STATE_FILE`에 저장되므로 bot restart 후에도 유지됩니다.

`/queue_mode`는 실행 중 새 메시지를 어떻게 처리할지 정합니다.

- `safe`: 실행 중인 turn 뒤에 queue로 순차 실행합니다. 기본값입니다.
- `interrupt`: 현재 turn을 중단하고 새 메시지를 다음 turn으로 실행합니다.
- `side`: 현재 turn은 유지하고 새 메시지는 별도 side thread에서 답변합니다.

## Runtime Overrides

`.env`는 시작 기본값입니다. 안전한 사용자 설정은 `/settings`에서 `.env`를 직접 수정하지 않고 바꿀 수 있습니다. 이 값들은 bot state에 저장되고, `Default`로 되돌릴 때까지 `.env`보다 우선합니다.

메뉴에서 바꿀 수 있는 runtime 설정:

- output: reaction, answer format, completion notice delay, 최대 메시지 길이, log 줄 수, progress edit interval
- queue: pending turn limit, pending turn expiry
- live progress: mode, interval, chat별 source/delete 정책
- cleanup: enable/disable, notify time, retention, quarantine, approval TTL
- snapshots: enable/disable, notify time, retention
- UI: language, time zone, locale

비밀값, token, 절대경로, process-level Codex SDK 생성자 값은 계속 `.env`에 두고 service restart로 반영합니다.

## Session Cleanup

봇은 하루 한 번 `CLEANUP_NOTIFY_TIME` 이후 `TELEGRAM_TIME_ZONE` 기준으로 cleanup 후보를 보냅니다. 버튼을 누르기 전에는 파일을 이동하거나 삭제하지 않습니다.

기본 정책:

- Telegram에 연결된 thread와 현재 실행 중인 Codex thread는 보호합니다.
- `CLEANUP_RETENTION_DAYS`보다 오래된 session log는 격리 후보가 됩니다.
- 격리 후 `CLEANUP_QUARANTINE_DAYS`보다 오래된 log는 영구 삭제 후보가 됩니다.
- 승인 plan은 `CLEANUP_PLAN_TTL_HOURS` 뒤 만료됩니다.

수동 검토는 `/cleanup`으로 할 수 있습니다.

`/tools` panel에는 `Codex Maintenance`도 있습니다. report는 읽기 전용이고, backup, config prune, worktree archive, log rotate는 backup-first 방식으로 동작하며 영구 삭제를 피합니다. SQLite metadata repair는 별도 명시 버튼으로 실행되며, session JSONL transcript는 변경하지 않습니다. Active thread handoff 생성도 버튼으로 제공됩니다.

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
