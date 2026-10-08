# Security Policy

## Supported Versions

Security fixes target the latest public release.

## Secrets

Never commit these values:

- `TELEGRAM_BOT_TOKEN`
- `ALLOWED_USER_IDS` when it reveals private accounts
- `CODEX_ACCESS_TOKEN`
- `OPENAI_API_KEY`
- `CODEX_API_KEY`
- `.env`
- `$CODEX_HOME/auth.json`
- runtime `state/`, `backups/`, `uploads/`, or Codex session files

Use `.env.example` or `.env.minimal.example` as templates only. Put real values
in your local `.env` or GitHub Actions secrets.

## GitHub Actions

The optional Codex PR review uses `CODEX_ACCESS_TOKEN` for Codex OAuth login.
Failed-CI diagnosis is deterministic and never supplies untrusted logs to a
credentialed model. It does not need a Codex token.

For public repositories, GitHub does not expose repository secrets to untrusted
fork pull requests. That is expected and safer than running AI review with
secrets on arbitrary fork code.

## Reporting a Vulnerability

Please open a private security advisory on GitHub when possible. If that is not
available, open an issue with a minimal description and avoid including tokens,
logs with secrets, or private chat exports.

## Local Hardening

- Restrict `ALLOWED_USER_IDS` to trusted Telegram users.
- Prefer `CODEX_SANDBOX_MODE=workspace-write` or `read-only` for routine use,
  with `CODEX_WORKER_MODE=inline`, `CODEX_STEERING=false` and
  `CODEX_INTERACTIVE_QUESTIONS=false`, and keep the sidecar service stopped.
- Same-user sidecar execution requires explicitly trusted `danger-full-access`;
  RPC credentials do not provide OS isolation. Do not weaken sandbox settings
  just to make sidecar execution pass. See [upgrade details](docs/security-hardening-20261008.md).
- Full `/backup` is available only in private chats to explicit
  `BACKUP_ADMIN_USER_IDS`; the default permits nobody.
- Keep `CODEX_APPROVAL_POLICY` conservative for shared machines.
- Review cleanup and maintenance actions before approving them from Telegram.
- Back up bot state before moving or pruning Codex session data.
