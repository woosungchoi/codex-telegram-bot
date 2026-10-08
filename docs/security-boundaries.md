# Security boundaries and verified updates

The seven follow-up findings are addressed in the process environment, full-state
backup authorization, maintenance filesystem operations, and CI/update paths.

## Codex process environment

SDK, direct app-server and worker/account execution use the same positive
allowlist in `src/codex/child_env.js`. Runtime paths, locale, TLS/proxy settings
and the selected `CODEX_HOME` are retained. Default-account Codex/OpenAI API
authentication is retained; managed accounts use their own file-based login.
Bot tokens, GitHub credentials, arbitrary future secret variables and loader
variables such as `NODE_OPTIONS`/`LD_PRELOAD` are not inherited, including from
`CODEX_ENV_JSON`. Extra application variables are no longer forwarded wholesale.

This controls inheritance; it is **not OS credential isolation**. A trusted
full-access worker running as the bot's Unix user can still read that user's
files. Run untrusted workloads under a separate user/container with limited
mounts and egress. Do not describe a different `CODEX_HOME` as a security sandbox.

## Full-state backups

Both `/backup` and old `tool:backup` callbacks require an allowed user explicitly
listed in `BACKUP_ADMIN_USER_IDS`, in that user's own private chat. The underlying
manual backup service enforces the same rule before file creation. Delivery
rechecks the identity and destination. The shared tools panel no longer advertises
full-state backup. Chat-scoped export is unchanged. Internal daily snapshots have
a separate noninteractive call path and cannot be invoked by forging a source name.

## Cleanup and handoff files

Linux maintenance opens every directory component using `O_DIRECTORY|O_NOFOLLOW`
and performs mutation through pinned `/proc/self/fd` directory handles. File
candidates carry device/inode/type identity from planning and are checked again
at execution. Old previews without identity must be regenerated. Parent symlinks,
final symlinks, replaced candidates and hardlinked quarantine sources fail closed.
Cross-filesystem quarantine moves fail rather than use an unsafe path-copy fallback.

This blocks traversal redirection to external targets, including a parent swap
after validation. It does not promise transactional exclusion against another
hostile process with the same Unix account and access to the pinned directory.
Keep maintenance roots private and do not give untrusted processes the bot UID.
Non-Linux platforms have no unsafe path-based mutation fallback.

Handoffs are written only inside `CODEX_HANDOFF_DIR` (default `~/.codex/handoffs`),
never inside a repository's `docs` directory. Directories are private, files are
0600, names contain random IDs, and exclusive no-follow creation prevents
replacement of existing files. Repository-relative handoff storage is discontinued.

## CLI update trust manifest

The bot no longer downloads or executes `install.sh`. A CLI update requires an
operator-maintained `CODEX_UPDATE_TRUST_FILE` with an independently reviewed digest,
exact version and platform. Missing approval disables the update button and the
underlying staging operation. Merely fetching a checksum beside the artifact from
the same compromised endpoint is not independent verification.

Example schema (replace placeholders after independent verification):

```json
{
  "artifacts": [{
    "version": "0.160.0",
    "platform": "linux",
    "arch": "arm64",
    "url": "https://YOUR-VERIFIED-RELEASE-HOST/codex.tar.gz",
    "format": "tar.gz",
    "binary": "codex-aarch64-unknown-linux-musl",
    "sha256": "REPLACE_WITH_64_LOWERCASE_HEX_DIGEST"
  }]
}
```

Keep the file outside workspaces, mode 0600, in an administrator-controlled
private directory. Group/world-writable files and symbolic manifest files are
rejected. The archive's digest is checked before parsing or execution. Extraction
accepts only a single approved regular executable plus optional directories;
absolute/traversal paths, links, metadata extensions and extra executables are
rejected. Download and decompression are bounded. Only then is `--version` run in
a fresh staging home with filtered environment. Service-idle gating and rollback
remain in force. Existing installed Codex continues to run without a manifest.

## GitHub Actions

PR review fetches a bounded diff as data on the trusted base, never checks out PR
code, and never runs a PR-owned helper. Fork PRs receive no Codex OAuth secret.
Review has read-only repository permission. Publication runs on a separate runner
with the helper from the immutable base SHA, no Codex credentials, bounded regular
text input, and a current-head check. Existing bot comments are updated without
executing artifact text. Model output remains untrusted review text, not authority
to merge or execute. The reviewer OAuth file is still a credential in the review
runner; read-only sandboxing is not same-UID read isolation. Use a narrowly scoped
review account or leave optional `CODEX_ACCESS_TOKEN` unset if that exposure is
unacceptable. Repository write credentials never enter that runner.

Dependency installation, tests and CLI smoke checks run without publication
credentials, with read-only repository permissions and nonpersistent checkout
authentication. Only two bounded JSON files cross into a new publication runner.
The trusted publisher validates version-only package changes and registry lock
entries, then uses GitHub's data API to create a content-bound branch and PR. It
never installs packages, executes artifact content, force-pushes main, or bypasses
required review/checks. Repeated identical updates reuse the same branch/PR.
Actions used by these two workflows are pinned to full commit hashes.

Regression evidence is in `test/security_seven.test.mjs`, account transport,
backup, cleanup, handoff, updater, and publication helper tests. Tests use temporary
files and fake credentials; no real Telegram messages or external email are sent.
