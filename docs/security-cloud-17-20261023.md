# Security Cloud 17 follow-up remediation

Scope: the 2026-10-23 report against public commit `ee20dd2f7630e5dba594490acfe8641b6ea478d7`, plus the worker recovery provenance regression. This is source remediation, not a new Security Cloud rescan or evidence of a compromise.

| Finding | Change and required regression |
| --- | --- |
| 1 | No generated executable restore scripts. A fixed installed Python utility consumes authenticated control records, verifies the diagnostic manifest digest and approved root/inode identities, pins directory descriptors, creates destinations exclusively and claims each restore once. Modified manifests/records, symlinks and replaced payloads fail before mutation. Permanent deletion remains irreversible. |
| 2 | Cleanup requires an explicit private-chat operator. Plans retain actor/bot/chat/topic provenance and a signed digest outside artifacts; apply reauthorizes before mutations. Legacy manual plans require a new preview. |
| 3 | Health write probes use unpredictable exclusive no-follow files through pinned parents; cleanup stays on the original directory descriptor. |
| 4 | Global restart/recovery commands and callbacks require a private operator. Persisted lifecycle operations recheck current authorization before execution. Revoked self-restart requests do not fall through to an unconditional exit. |
| 5 | Host Python receives bounded, no-follow, owner/mode-checked helper bytes matching the bundled approved SHA-256. Python executes the checked in-memory source rather than reopening the mutable helper path. |
| 6 | Release tag ancestry and package version are checked before install. Build/tests have read-only permissions and no persisted checkout credential. A separate write job checks the verified commit and publishes without checkout or repository code execution. |
| 7 | Publisher verifies existing branch/PR head against its deterministic approved commit. The actual public auto-merger requires independently configured exact commit and package/lock hashes; rebasing requires renewed approval. |
| 8 | Backups and exports use random exclusive files with anchored, no-follow creation, single-link checks, private modes and fsync. |
| 9 | Global settings require the operator role; destructive confirmation is bound to actor, bot/chat and value, expires and is consumed once. |
| 10 | No automatic grant of the shared upload root. Attachments have separate capability directories and aggregate quota accounting. Inline, sidecar and parallel turns receive their own directories; resumed sessions replace earlier writable-root grants. Stored uploads retain the existing retention policy. |
| 11 | Health state reads pin parents, reject links/devices/FIFOs and read at most 16 MiB from a regular single-link file. |
| 12 | Dependency staging is outside the application/model roots. Authenticated tree attestations include all file bytes, modes, paths and safe symlink targets. Verify before/after tests, before activation and after the move; mismatch preserves/rolls back the live installation. |
| 13 | Shared-home maintenance mutations/toggles require an operator, bind confirmation, and exclude all active/side turns. Admission is paused while the helper runs. Legacy automatic repair needs a newly authorized toggle. |
| 14 | Queue controls check the requester or explicit queue moderator. Shared pause/mode requires a moderator. Bulk confirmation binds actor and exact target set; side-turn stop includes ownership. |
| 15 | Preview captures the full approved CLI artifact and relevant configuration digest; an authenticated record binds them to the update ID, SDK and origin. Detached execution rejects changed configuration/artifact before effects. |
| 16 | CI metadata is bounded and escaped, newlines flattened, mentions neutralized and run URLs restricted to GitHub Actions paths. |
| 17 | Detached completion propagates requester/version/account/bot/chat/topic/forum provenance. Current policy is checked before each send/edit attempt. Notification failure never repeats activation. |
| Recovery | `createWorkerRecoveryTurn` preserves original provenance, including the account and forum flag; incomplete/revoked records remain blocked. Positive authorized recovery reaches final delivery once. |

The earlier twelve fixes remain in place: session ownership, current request authorization, upload quota, disabled credentialed reviewer, update isolation/independent lock approval, output-artifact ownership and strict audit handling. The new findings cover adjacent entry points and time-of-check/time-of-use gaps; they do not imply the older controls should be removed.

## Operator migration

Set `OPERATOR_USER_IDS` explicitly to existing authorized operators and optionally `QUEUE_ADMIN_USER_IDS` for shared-topic moderators. A general allowlisted participant never becomes an operator implicitly. New role checks also apply to old buttons. Use a fresh cleanup/settings preview after deployment. Existing sessions and quarantine payloads are not rewritten or deleted by this patch.

Provision `MAINTENANCE_CONTROL_DIR` with mode 0700 for the service identity, outside the application, workdir, additional writable roots and uploads. Install `scripts/restore-cleanup.py` as the trusted `MAINTENANCE_RESTORE_SCRIPT` (default `/usr/local/lib/codex-telegram-bot/restore-cleanup.py`). Back up the control directory, including its key and immutable receipts; losing them intentionally prevents unauthenticated restoration. Never execute an old artifact's `restore-cleanup.py`. Legacy artifacts need an independent administrator review/migration; no silent signing of old mutable manifests occurs.

Control records are single use and fail closed after uncertain partial restoration; inspect the retained claim and file identities instead of deleting claims to retry blindly. Restore requires existing original parent directories and refuses cross-device moves or existing destinations.

CLI/SDK updates remain disabled unless independently approved trust metadata and namespace isolation are available. Public auto-merge additionally needs repository variables `CODEX_APPROVED_COMMIT`, `CODEX_APPROVED_PACKAGE_SHA256`, and `CODEX_APPROVED_LOCK_SHA256`, maintained by authorized reviewers. A successful CI run is not artifact approval.

## Boundary and validation limits

Directory modes, random names and capability grants do not create isolation between fully unsandboxed processes sharing an OS identity. In particular, `danger-full-access`, a workdir containing other users' inputs, or a sandbox allowing unrestricted filesystem reads cannot provide cross-user read confidentiality. Hostile multi-user execution requires separate OS identities or mount namespaces with input-specific read and write visibility. This patch removes the explicit shared writable-root grant; it does not claim stronger OS isolation.

Tag protections and trusted repository-variable administration remain external deployment controls. Mocked notification/publication tests never contact real Telegram recipients or create GitHub comments. Actual update activation tests use fixture services and dependencies; production CLI packages are not upgraded as part of this security patch.

Rollback: stop admitting new work, restore the previous code commit and restart through the existing lifecycle. Preserve control receipts, input directories, state, sessions and quarantine. Never roll back by replaying cleanup, an update, or notification delivery. No destructive operational data migration is included.
