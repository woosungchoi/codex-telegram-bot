# Telegram polling recovery

The existing `getUpdates` consumer has an automatic request guard. A normal poll
waits up to 50 seconds; the guard logs a slow-request warning at 65 seconds and
aborts an unresponsive HTTP request at 75 seconds. Once cancellation settles,
Telegraf retries with its existing five-second backoff and the same update offset.
This does not restart the bot or worker, cancel Codex tasks, replay jobs, or start
a second consumer. Shutdown cancellation and Telegram 401/409/429 handling retain
Telegraf's existing semantics.

Standard logs record structured `telegram_poll_slow`, `telegram_poll_timeout`,
`telegram_poll_error`, `telegram_poll_recovered`, and `telegram_update_delayed`
events. Errors are redacted; message content and chat identities are not recorded.
New messages older than 30 seconds on receipt produce a delay event; old callback
targets and edited messages do not.

The `polling` field of `<CODEX_UPDATE_DIR>/telegram-polling-health.json` includes
error and timeout counts, last error/success/request times, and message lag
metrics. The file is private (0600) and refreshed every five seconds and after
polling completes or fails. Counters reset on process restart; service logs retain
the event history. A failed diagnostic write does not fail a successful poll.

For systemd installations, inspect `journalctl --user -u codex-telegram-bot.service
--since today` and filter for `Telegram polling:`. Request recovery works even
without diagnostic state storage. It cannot restore a failed network, unblock a
stuck JavaScript event loop or message handler, or recover a transport that
ignores abort signals. It waits for cancellation instead of risking concurrent
`getUpdates` consumers.
