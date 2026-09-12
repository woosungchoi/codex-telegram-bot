# Release Checklist

Use this checklist before tagging a public release or deploying the bot to a
personal service host.

## Automated Gates

Run from a clean checkout:

```bash
npm ci
npm run verify
npm run check
npm run lint
npm run format:check
npm test
npm audit --audit-level=moderate
npm pack --dry-run --json
```

`npm run format:check` currently covers package metadata and GitHub workflow
YAML formatting. Broader documentation formatting should be handled as a
separate change.

Confirm the dry-run package includes runtime source, docs, assets, systemd
files, and executable bin entries.

### CLI selection checks

`npm test` verifies the installed package-local CLI with an isolated child
environment, then separately compares `codex-yolo --version` against the CLI
selected by the current `CODEX_REAL_PATH` override (or the local default).
Their versions may legitimately differ; neither check pins a version string.

To check another already-installed CLI, including a newer release, run:

```bash
CODEX_REAL_PATH=/absolute/path/to/codex node --test test/package_bin.test.mjs
```

This sets the override only for that test process. Tests do not download the
latest CLI, change `.env`, update dependencies, or execute a model turn. A
missing or broken explicitly configured CLI remains a failure, not a skip.

## Startup Smoke

Before restarting the service, confirm the runtime configuration and local state
backup are present:

```bash
test -f .env
test -d state || mkdir -p state
systemctl --user restart codex-telegram-bot.service
systemctl --user is-active codex-telegram-bot.service
journalctl --user -u codex-telegram-bot.service --since "10 minutes ago" --no-pager
```

The journal should not show startup exceptions, Telegram polling conflicts, or
authorization errors from the expected operator chat.

## Telegram Smoke

Run these from the authorized chat or forum topic:

- `/health`
- `/whoami`
- `/settings`
- one small text Codex turn
- one image Codex turn
- queue mode checks for `safe`, `interrupt`, and `side`
- `/backup`
- `/cleanup_status`
- `/cleanup_uploads`, then press `Confirm upload cleanup` only against a
  disposable staging upload directory

For queue mode checks, keep prompts small and verify the active turn, queued
turn, and side turn statuses behave as expected.

## Release Steps

1. Update `package.json` version and `CHANGELOG.md`.
2. Run `npm run verify` and `npm pack --dry-run --json`.
3. Commit the release changes.
4. Create and push an annotated tag:

```bash
git tag -a "v$(node -p "require('./package.json').version")" -m "Release $(node -p "require('./package.json').version")"
git push origin main --tags
```

5. Confirm the GitHub release workflow completes and the generated release notes
   are accurate.

## Rollback Readiness

Before release, identify the previous known-good tag and confirm
`docs/rollback.md` still matches the deployment path.
