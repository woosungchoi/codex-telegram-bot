# Chat sign-in and multiple Codex accounts

`/reauth` signs in to ChatGPT from Telegram using Codex's official device-code
flow. `/accounts` manages named sign-ins and optional automatic failover.
This integration was verified against Codex CLI 0.153.4 and SDK 0.151.0.
The CLI must support App Server `account/login/start` with `chatgptDeviceCode`.

## Commands

| Command | Behavior |
| --- | --- |
| `/reauth [name]` | Add a named ChatGPT sign-in; open the official link and enter the one-time code. |
| `/reauth cancel` | Cancel a pending login. |
| `/accounts` | List accounts, choose one, check status, remove a saved login, and toggle automatic rotation. |
| `/accounts use <id>` | Select the account for subsequent work in this chat. |
| `/accounts rename <id> <name>` | Rename a saved account. |
| `/accounts check <id>` | Refresh login status and available quota/reset information. |
| `/accounts remove <id>` | Show a confirmation before deleting the login and its local session files. |
| `/accounts rotate on` / `off` | Enable or disable rotation for the bot's saved account pool. Default: off. |

Account management is restricted to private chats with account administrators.
`CODEX_ACCOUNT_ADMIN_USER_IDS` must also be in `ALLOWED_USER_IDS`. With one
allowlisted user that user is the default administrator. With multiple users,
configure administrators explicitly. The saved account pool is shared by this
trusted bot installation; it is not a separate operating-system user sandbox.

ChatGPT may require enabling device-code login in personal security settings or
workspace permissions. Passwords and tokens are never requested in Telegram.
The login code message is protected from forwarding and deleted on completion,
cancellation, or expiry. A failed login removes only its staging profile.

## Storage and switching

The `default` entry uses the existing host login, configuration and session
directory. It does not copy or replace the host's `auth.json`; existing API-key
configuration also stays attached to this entry. Additional accounts use
`CODEX_ACCOUNTS_DIR/profiles/<id>` as their `CODEX_HOME`, with file credential
storage and separate sessions, databases, and model caches. Directories are
private (`0700`), and the index/config/credential files are `0600`.

The default account directory is `state/accounts`; set `CODEX_ACCOUNTS_DIR` to
change it. The account registry contains labels, status and quota metadata only.
Credentials never enter bot state, normal `/backup` or `/export` payloads.
Managed profiles copy the common configuration at creation and link installed
skills, plugins, rules, `AGENTS.md` and `MEMORY.md`. Updating the common config
later requires updating/recreating a profile's config; project files remain
shared as before. Managed processes exclude ambient API keys/access tokens.

Selecting another account applies to the next task. Active work retains its
original account; live file leases prevent deleting an account while it is in
use. SDK clients, thread mappings, model catalogs, and worker jobs carry account
identity. `/threads` and `/resume last` use the selected account's session root.
The host/default entry cannot be deleted through the bot.

## Automatic rotation

The bot lets the CLI finish its own retries. A final, recognizable account quota
or authentication failure can move the task to another ready account. Generic
429s, network failures, invalid requests, unavailable models, permissions,
context exhaustion and cancellation do not trigger account rotation.

Each eligible account is tried at most once. Quota failures receive a 15-minute
cooldown; a successful status check can replace it with the server's reset time.
Authentication failures require a fresh sign-in or successful status check.
Account attempts and activity are persisted so restart recovery keeps the
original identity and excludes accounts already tried unsuccessfully.

Rotation is allowed only before any streamed output or tool activity. If a turn
already started work, the bot reports the failure instead of replaying its
commands under another identity. Cancellation always prevents a new attempt.
The old CLI must exit before another account is started. A successful account
becomes the selected account unless the user changed the selection meanwhile.

Cross-account recovery creates a **new thread**. It passes the original input
and a bounded text history (at most 12 user/assistant messages and 16,000
characters) as context. It does not transplant encrypted reasoning or promise
lossless cross-account session resume. Original session files are preserved.

## Deployment and validation

Update both `codex-telegram-bot.service` and `codex-telegram-worker.service`.
Workers advertise `accounts-v1`; the bot refuses to submit a managed account to
an older worker. Drain active work and final-message delivery before restarting
the worker. The default account remains compatible during a rolling update.

Run `npm run check`, `npm run lint`, and `npm test`. Account tests cover storage
permissions, concurrent registry access, leases, administrative access,
device-login races/cancel/expiry, account selection, bounded rotation,
cancellation, partial tool activity and both real SDK/App Server subprocess
adapters using a local fake CLI. They do not log in to production accounts or
consume model quota. A real additional account requires the user's browser
sign-in before a live two-account smoke test can be performed.

References: [Codex authentication](https://learn.chatgpt.com/docs/auth),
[App Server](https://learn.chatgpt.com/docs/app-server), and
[Grok Telegram Bot](https://github.com/artickc/grok-telegram-bot).
