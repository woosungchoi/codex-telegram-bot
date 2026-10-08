# Security Model

This bot is designed for a trusted personal or small-team Telegram chat, not for
public anonymous access.

## Trust Boundaries

- Telegram users are trusted only after their numeric id is listed in
  `ALLOWED_USER_IDS`.
- If configured, `ALLOWED_CHAT_IDS` restricts authorized users to specific chats.
- If configured, `ALLOWED_THREAD_IDS` restricts authorized users to specific
  forum topics or message threads.
- Codex can read or write according to the configured sandbox and approval
  policy.
- Runtime state and Codex sessions are local files and may contain private
  content.
- GitHub Actions secrets are available only according to GitHub's event rules.

## Codex OAuth in GitHub Actions

The optional PR review uses `CODEX_ACCESS_TOKEN` only when configured as a
repository secret. Failed-CI diagnosis uses deterministic classification and
redaction, without a Codex login or agent execution.

Pull requests from forks normally cannot access repository secrets. In that
case, Codex review skips while normal CI and deterministic diagnosis still run.

## Telegram Safety

- Keep `ALLOWED_USER_IDS` narrow.
- Service notifications such as dashboard pins and membership changes are
  ignored. Forum lifecycle notifications update topic state only after the
  sender passes the normal user, chat, and topic allowlists. They never count
  as text input to an open menu.
- Denied user requests log the reason and numeric update/user/chat/topic IDs,
  without message text or callback payloads. Private chats receive a localized
  explanation; denied button clicks receive an alert. Unknown group users do
  not trigger chat replies. A service notification, bot sender, or nested
  message author never grants access to commands.
- Use `/whoami` in the target chat or topic before tightening
  `ALLOWED_CHAT_IDS` or `ALLOWED_THREAD_IDS`.
- Treat Telegram as a command surface for the machine running the bot.
- Avoid `danger-full-access` unless the host is disposable or tightly isolated.
- `CODEX_SKIP_GIT_REPO_CHECK=false` is the default. Set it to `true` only when
  you intentionally want Codex to run outside Git worktrees.
- Use `/settings` and `/tools` to inspect active sandbox, approval, queue, and
  maintenance state.

## Data Handling

The bot may store:

- chat preferences
- queue data
- downloaded image inputs
- cleanup manifests
- backups
- Codex thread ids and session references

Keep `state/`, upload directories, backups, and Codex session directories out of
Git. Before sharing logs, redact tokens, chat ids, paths, and private prompts.
Use `/cleanup_uploads` to preview downloaded image deletion candidates, then
press the inline `Confirm upload cleanup` button to delete. The typed
`/cleanup_uploads_confirm` command does not delete files. Confirmed upload
cleanup refuses candidates outside the configured upload directory.

## Worker and artifact boundaries

Same-user processes are not isolated by socket permissions or bearer credentials.
Sidecar execution requires explicit operator and per-job `danger-full-access`;
unsupported sandboxed sidecar jobs fail closed. For sandboxed inline work, disable
steering and interactive questions and stop the worker service. The example env
files select this inline configuration. Existing unspecified runtime defaults are
retained; existing sidecar configurations must be reviewed before upgrading.

Worker credentials rotate on restart; question tools receive expiring job-scoped
capabilities. Restart both processes after draining current work when upgrading
this protocol. Full backups require a private chat and an explicitly allowed
backup administrator. Attachment paths use Linux descriptor checks and validated
byte copies; unsupported platforms fail closed. See the
[hardening and migration notes](security-hardening-20261008.md).
