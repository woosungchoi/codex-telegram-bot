# Chat sign-in and multiple Codex accounts

`/reauth` signs in to ChatGPT from Telegram using Codex's official device-code
flow. `/accounts` manages named sign-ins and optional automatic failover.
This integration was verified against Codex CLI 0.153.4 and SDK 0.151.0.
The CLI must support App Server `account/login/start` with `chatgptDeviceCode`.

Introduced in **1.3.0**, these features were inspired by **artickc**'s
[Grok Telegram Bot](https://github.com/artickc/grok-telegram-bot), especially
its chat sign-in, multiple-account management, and auto-rotate design.
Thank you for the inspiration; this integration adapts those ideas to Codex's
device-code login and isolated account homes.

## Commands

| Command | Behavior |
| --- | --- |
| `/reauth [name]` | Add a named ChatGPT sign-in; open the official link and enter the one-time code. |
| `/reauth cancel` | Cancel a pending login. |
| `/accounts` | List accounts, choose one, check status, remove a saved login, and toggle automatic rotation. |
| `/usage` | Show the selected account's live usage, remaining quota, and reset times. |
| `/accounts use <id>` | Select the account for subsequent work in this chat. |
| `/accounts rename <id> <name>` | Rename a saved account. |
| `/accounts check <id>` | Refresh login status and available quota/reset information. |
| `/accounts remove <id>` | Show a confirmation before deleting the login and its local session files. |
| `/accounts rotate on` / `off` | Enable or disable rotation for the bot's saved account pool. Default: off. |

### Button menu

Open `/accounts` to manage accounts without copying their IDs. `/menu` also
offers **Accounts**, **Add account**, and **Usage** buttons:

- **Usage** (also in the account list) initially reads the selected task account's
  limits directly, including separate model pools such as Spark when provided.
  Each window uses its reported duration, so a primary weekly window is shown
  as weekly. Reset and query times follow the bot's date/time preferences.
  **Refresh** updates the same message with a fresh query; **Accounts**,
  **Main menu**, and **Close** provide navigation. `/usage` opens this same panel.
  These queries do not start a Codex turn or consume model-generation quota.
  Missing limits and failed queries show guidance with navigation still available.
- **Account name buttons** inside Usage display another saved account's quotas
  and reset credits in the same message. ✅ marks the account being viewed.
  Browsing never changes the selected task account or its threads. **Refresh**
  stays on the displayed account, even if task selection changes elsewhere.
  Opening `/usage` or the main **Usage** button starts with the task account.
  Deleted accounts show guidance and retain buttons for the remaining accounts.
- The usage panel also shows **Reset credits**: the server's available count
  and up to five credit titles/expiry times. The count remains authoritative
  when detail rows are capped or unavailable; missing data is not shown as zero.
  **Refresh** updates both quotas and reset credits. Credit IDs are not shown
  in Telegram.
- **Use Reset credit** in Accounts or Usage opens the viewed account's available
  credits as buttons, with titles and expiry details. Account buttons switch the
  redemption target without changing the task account or its threads. Longer
  lists have page buttons. When only a count or capped details are available,
  **One available credit (automatic)** lets the service choose one explicitly.
  Selecting a credit opens a confirmation naming the account and credit;
  **Use this Reset credit** makes the actual request. A successful reset consumes
  one credit and cannot be undone. Used, unsupported, and expired detail rows
  cannot be selected. The service decides whether any quota window is eligible.
  Success, already-completed requests, no available credit, and nothing to reset
  have distinct messages; the usage panel then reads the actual updated limits.
- Reset confirmations expire after five minutes and are bound to their
  administrator, private chat, and message. Double clicks cannot replay a
  completed confirmation. Before a use request, the bot saves the exact account,
  credit, and idempotency key in private state. An uncertain response offers
  **Recheck same request**, retaining that key even across navigation or restart;
  resolving it takes precedence over a new redemption for that account. Closing
  a menu cancels an unsent confirmation, but cannot undo an already-sent request.
- **Add account** asks for a name. Send it as your next message, then complete
  the ChatGPT device-code sign-in. The completion message offers **Use** and
  **Accounts** buttons.
- **Rename** under an account asks for its new name and saves it when you reply.
  Names support Unicode and spaces and must contain 1–48 characters.
- **Remove** shows the account name and asks for **Confirm removal**. Removal
  deletes the saved login and its account-local session files. The host's
  default account can be renamed but cannot be removed here.
- **Cancel** returns to the account list. A slash command or a button in another
  menu also ends a pending account menu step so it is handled normally.
- **Close** dismisses the account menu and clears any pending name input or
  removal or unsent Reset confirmation. It does not delete an account. The device-code sign-in
  message retains its separate **Cancel** button for stopping authentication.

Name input and removal confirmations expire after five minutes. Pending steps
survive a bot restart for their remaining lifetime and are bound to the
requesting administrator and private chat. Confirmation and Cancel buttons are
also bound to the specific prompt; old or already-used buttons cannot apply a
different operation. While a name is requested, the next message is handled by
the account menu instead of becoming a Codex prompt.

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
[App Server rate limits and reset credits](https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt),
[Reset credit consumption](https://learn.chatgpt.com/docs/app-server#8-earned-rate-limit-resets-chatgpt), and
[Grok Telegram Bot](https://github.com/artickc/grok-telegram-bot).
