# Telegram project topics

Keep a separate working directory, account, model, Codex session and queue for
each project in a private conversation with your bot or a forum supergroup.

## Get started

### Private chats

1. Open the [BotFather mini app](https://t.me/botfather?startapp=), also available
   through **Open App** in the BotFather conversation. Select your bot, open
   **Bot Settings**, scroll to **Threaded Mode**, and enable it. The classic
   `/mybots` chat-button menu may not show this setting; use the mini app.
2. Run `/forum_setup` in your private conversation with the bot. You can also
   choose **Set up private topics** in `/topics`.
3. In `/topics`, choose **Create project topic**, select a saved project or an
   existing directory, and enter a topic name.
4. Select the new topic in Telegram's topic list and start working.

Setup and topic creation refresh `getMe.has_topics_enabled`. If it is disabled,
the menu explains how to enable it; enable Threaded Mode and retry the same
button. A bot restart or new group is unnecessary. The bot does not change
BotFather settings. Allowing users to create topics through Telegram's native
interface is a separate setting from the bot's ability to create them. See
[Telegram's private topic documentation](https://core.telegram.org/bots/features#topics-in-private-chats).

Setup preserves the existing private conversation's settings and session, and
those of the topic where setup was requested. Continue normal work there, or
use **Dispatch work** / `/dispatch` to send a request to another project topic.
Private setup does not automatically create General or AI Chat topics. Private
topic `1` is treated as a real, distinct topic; sessions, queues and account-name
input steps remain isolated from the root conversation and other topics.

**Pause topic work / Resume topic work** controls new bot work in private topics
without deleting the topic or its history. The bot does not call the group-only
`closeForumTopic` / `reopenForumTopic` APIs in private chats. Navigate through
Telegram's topic list; group topic links are not generated for private chats.
See the [Telegram topic API](https://core.telegram.org/bots/api#closeforumtopic).

### Forum groups

1. Enable **Topics** in the Telegram group's settings.
2. Make the bot a group administrator with **Manage topics** permission.
3. Run `/forum_setup` inside the group.
4. Open `/topics` or **Project topics** in `/menu`.
5. Choose **Create project topic**, select a saved project or enter an existing
   directory path, then enter a topic name.

The bot checks the group's forum status and its own permissions with `getChat`
and `getChatMember`. It does not automatically convert a regular group into a
forum. Repeated setup does not duplicate a registered AI Chat topic. Telegram's
[createForumTopic documentation](https://core.telegram.org/bots/api#createforumtopic)
describes the required group permissions.

Existing `ALLOWED_USER_IDS`, `ALLOWED_CHAT_IDS` and `ALLOWED_THREAD_IDS` restrictions
still apply. When a thread allowlist is configured, the bot does not grant access
to new topic IDs: automatic AI Chat creation is skipped and new project-topic
creation is restricted. Bind a project to an already allowed topic instead.

## Topic roles in groups

| Topic | Behavior |
| --- | --- |
| General | Enter a request, select a project, dispatch work and receive status |
| AI Chat | Normal Codex conversation in the directory captured during setup |
| Project topic | Work with the bound directory, session and queue |
| Unbound topic | Show the project-binding menu before running work |

A message such as `Fix the login error and run the tests` in General opens
project-selection buttons. Selecting a project places the request in its queue;
if it is busy, the request follows the existing work. General does not execute
that text as a local coding request.

Use **Dispatch work** in `/topics` to send work from AI Chat or another project.
You can also use commands:

```text
/dispatch
/dispatch Fix the login error
/dispatch My App | Fix the login error and run the tests
/dispatch #123 | Review the changes
```

Without a destination, choose one with buttons. An explicit destination must be
an exact topic name or `#topicID`. Requests are limited to 8,000 characters. Send
files and photos directly in the destination topic. The user selects where work
runs; model-generated JSON and code blocks are not executed as bridge commands.

## Project bindings and sessions

- Select `/projects` presets saved by the **same user** in private chats or other
  topics. A preset supplies its directory, account, model, reasoning and tier.
- Enter an existing absolute directory path or exact saved project name. The bot
  does not create directories automatically.
- A user-created topic whose name exactly matches a saved project, ignoring case,
  is bound automatically. Partial or similar names are not guessed.
- Paths are resolved before binding, including symlinks. Each project directory
  can be bound to only one project topic in a given chat.
- `/new`, `/stop`, `/queue`, model settings and active work stay isolated per topic.
  `/new` starts a fresh session under that topic's selected account.
- In a bound project topic, use `/sessions` to continue a session from the **same
  directory**. `/resume` directs you to this menu. Change the binding through
  `/topics` before switching to a different directory.
- Finish or stop active and side work, clear queued work and resolve pending
  final delivery before rebinding or closing a topic.
- **Unbind** keeps the topic, files and session logs. Group **Close/Reopen topic**
  changes Telegram's topic state; private **Pause/Resume topic work** controls bot
  work. A menu's **Close** button only closes that menu.
- Up to 60 project topics may be registered per private chat or group.

## Completion and recovery

The result body goes to the destination project topic. Completion, failure or
cancellation status returns through the requesting bot to the **original chat
and topic**, with a topic-navigation button for groups. Work requested from AI
Chat reports to AI Chat; work from General reports to General. Private requests
also return status to their original root conversation or topic.

**Dispatched jobs** in `/topics` shows jobs requested by the current user and
their notification state. The bot rechecks its identity, the user, destination
allowlists and directory binding immediately before execution. Jobs and queues
share the persistent state file, and job IDs connect recovery to completion
records. Topic state uses `chatId:topic:threadId`; existing root-private and
group-General chat keys are preserved. The stored chat type also guides recovery
and delivery. Only the private chat's owner can manage or dispatch its topics.

If a connection failure or restart makes notification delivery uncertain, the
bot does not automatically send a duplicate. **Resend completion notice** retries
only the notification, without rerunning the task. A missing queue entry or an
uncertain execution is shown as interrupted, prompting result inspection before
rerunning it.

There may be at most 20 unfinished dispatched jobs globally. The latest 100 jobs
whose notifications completed are retained. Scheduled tasks remain in `/tasks`.

## Acknowledgements

Thank you to **artickc** and the contributors to
[Grok Telegram Bot](https://github.com/artickc/grok-telegram-bot) for sharing their
[forum workflow](https://github.com/artickc/grok-telegram-bot/blob/d4a5eb966d412f25e4f541526c01a8216c61543f/docs/GROUP.md).
These ideas were adapted to this repository's Telegraf menus and Codex execution,
account isolation and recovery architecture.
