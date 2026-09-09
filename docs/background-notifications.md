# Background completion notifications

Use the requesting bot's identity **and** chat/topic. A user ID alone is not a
delivery address across bots: a notification accepted through a different bot
still belongs to a different conversation.

For background jobs requested through this bot, use the sender from the bot's
installation directory. Set `EXPECTED_BOT_ID` and `TARGET_CHAT_ID` to the IDs
captured when the job was requested:

```bash
node scripts/send-background-notification.mjs \
  --expected-bot-id "$EXPECTED_BOT_ID" --chat-id "$TARGET_CHAT_ID" \
  --file /absolute/run/completion.txt --receipt /absolute/run/notification.json
```

Capture the actual bot ID, chat ID and optional Telegram `message_thread_id` at
launch. Add `--thread-id ID` for topics. Do not confuse the Codex UUID with a
Telegram topic ID. `--file -` accepts stdin. `--check-only` verifies the bot and
configured allowlists without sending or creating a receipt. `--help` is offline.

The sender loads **only this repository's `.env`** for bot credentials and
allowlists; an inherited Hermes/API token cannot change the sender. It checks
`getMe` before sending and validates the returned bot, chat, topic and message ID.
Plain text avoids Markdown parse failures and notifications are explicitly on.

Each receipt binds bot/chat/topic and text SHA-256. It uses a single-writer lock
and atomic fsync writes. `sent` is persisted only after Telegram acceptance;
repeating the same successful request reuses its receipt without sending again.
Only definitive rate-limit rejections retry automatically (at most three calls,
retry-after at most 60 seconds). Timeout, unknown errors, mismatched responses or
a crash during sending require reconciliation: Telegram offers no sendMessage
idempotency key. Do not delete a lock/receipt or blindly retry uncertain delivery.
An ordinary failed, explicitly rejected request can be retried using its receipt.

Keep the original wrong-bot receipt unchanged. Use a new Codex receipt for an
authorized corrective resend; do not rerun generation, deploy or verification
just to repair notification delivery. Never use a pre-send `notification-attempted`
file as a successful-delivery marker. `telegram_api_accepted` is API acceptance,
not proof that the user read it. No bot/worker restart is needed for this CLI.

Reference: [Telegram getMe and sendMessage](https://core.telegram.org/bots/api#sendmessage).
