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

Confirm the dry-run package includes runtime source, docs, assets, systemd
files, and executable bin entries.

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
- `/cleanup_uploads`

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
