# Telegram workspace menus

For project topics in private chats and forum groups, including work dispatch,
see the [project-topic guide](forum-topics.md). Open it with **Project topics**
in `/menu`.

The main `/menu` now includes Projects, Sessions, Scheduled tasks, Task dashboard,
and MCP servers. Every interactive menu has a Close button. `/cancel` leaves an
input wizard; opening another command also cancels its pending input. Menus are
bound to the requesting user, bot, chat, topic and message, and expire after
15 minutes.

## Projects — `/projects`

- Save the current working directory or browse existing folders. Enter an
  absolute path to open a folder outside the initial browser location.
- Name, search, rename, favorite and remove saved projects. Removing an entry
  never deletes the actual directory or its session logs.
- A preset captures the selected account, model, reasoning and service tier.
  Select the desired account/model in the existing menus, then choose
  **Save current account/model** on a project's card to update the preset.
- Opening a project applies its preset and starts a fresh session on the next
  message. Active, side, queued and pending-delivery work must finish first.
- Saved projects belong to the requesting user/chat/topic. Up to 60 may be saved.
  Folder pages show eight entries; a directory scan displays up to 250 folders.

## Sessions — `/sessions`

Browse eight recent sessions per page. **Current project** is the default and
matches the current working directory; **All history** includes other folders,
CLI sessions and automated tasks in the selected account. Scope, search and page
are retained when opening a session and going back; refresh and account changes
keep the scope/search and return to the first page.

Buttons show the updated date in the configured timezone, the last eight
characters of the session ID and the task title. All-history buttons also show
the folder name. Saved names take priority; otherwise a bounded read of the
account's session log extracts a user request, skipping injected style/context
and initial ready-confirmation prompts. Missing logs fall back to the API
preview, then an untitled label. Sessions and their saved names are not changed
or deduplicated by title. Search uses Codex's stored names/previews.

Inspect a preview before continuing. Account buttons browse another account without switching the
current working account. **Continue session** explicitly selects that account,
the session and its working directory. A session with a running turn cannot be
continued concurrently.

**Watch live** reads the selected session log every ten seconds for up to fifteen
minutes. It never starts a model turn or takes ownership of the running CLI.
The view includes user messages and assistant commentary/final answers; images,
hidden reasoning and tool output are omitted. Close or Stop watching ends the
watch. Log activity can be unknown when the bounded tail lacks a lifecycle event.

## Scheduled tasks — `/tasks`, `/newtask`

The wizard asks for a name, prompt, project and schedule, then shows the complete
configuration for confirmation. A project may be a saved preset or the current
folder/account/model. The schedule saves the bot's current IANA timezone.

| Schedule | Input example |
| --- | --- |
| Once | `2026-10-01 09:00` |
| Daily | `09:00` |
| Weekly | `1 09:00` (Monday = 1, Sunday = 7) |
| Monthly | `15 09:00` |
| Interval | `30` (minutes; minimum 5) |

Each task has Run now, Enable/Disable, Rename, Edit prompt, Change project,
Reschedule, Stop and Remove controls. Immediate execution, stopping and removal
have confirmation buttons. The card shows the next execution and five recent
runs; ten previous runs are retained. Up to twenty tasks may be saved per scope.

Runs use separate chat state and fresh Codex sessions, retaining the captured
account/options while leaving the interactive chat's session and settings alone.
They enter the existing persistent queue and execution/recovery pipeline, and
deliver through the originating bot to the saved chat/topic. The normal account
rotation policy still applies. Queue serialization retains the initial account
and destination across restart. The originating user, bot and access restrictions
are checked again before scheduled execution.

One task never overlaps itself. At most three scheduled runs execute concurrently;
pausing the destination's normal queue also pauses automatic dispatch. Missed
occurrences are coalesced into one run when service resumes; there is no backlog
of every missed occurrence. Daylight-saving gaps and nonexistent monthly dates
are skipped, and a repeated local minute runs once. Failed dispatch disables the
task and records its error on the card. Ambiguous interrupted executions are not
automatically replayed by the scheduler; inspect the result before Run now.

## Task dashboard — `/dashboard`

During work, a status card shows the current account, directory, model/reasoning,
elapsed time, recent progress and queue size. It updates every ten seconds and
offers Stop, Queue, Scheduled tasks and dashboard settings. Stop affects active
turns in that destination, including scheduled turns.

The card is pinned silently where Telegram permits it; without pin permissions
it remains an ordinary status message. Completion removes only this bot's card
and its own pin. Close turns off automatic cards for that chat/topic; re-enable
them from `/dashboard`. No estimated completion percentage is fabricated.

## MCP — `/mcp`

Account administrators can use this menu in private chats. It lists the effective
MCP configuration for the selected account and current working directory.
**Check connections** creates a temporary Codex thread without a model turn and
uses real MCP initialization to report connection state, tools and startup errors.
The temporary connection is closed after the check.

Enable/Disable changes only the selected server's `enabled` setting in that
account's user config, using Codex's config API and its revision check. Managed or
project-level overrides are reported. Plugin-provided servers are inspectable;
their enablement is managed by the plugin configuration. Changes and reconnects
require the account's active work to finish. New turns load the changed settings;
the Telegram bot and worker services are not restarted by these buttons.

## Implementation references

Menu ideas were inspired by
[artickc/grok-telegram-bot](https://github.com/artickc/grok-telegram-bot/tree/d4a5eb966d412f25e4f541526c01a8216c61543f)
(MIT). The implementation uses this repository's Telegraf menus, account homes,
queue and recovery architecture. Codex operations use the
[official App Server interface](https://learn.chatgpt.com/docs/app-server#api-overview).
