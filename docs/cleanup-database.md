# Cleanup and conversation databases

Set `CLEANUP_DATABASE_ENABLED=true` and restart the bot to include supported
Codex conversation databases in session Cleanup. The default is `false`.
This feature requires Linux with procfs and Python 3.9+ with `sqlite3`.
No database credentials or additional npm dependencies are required.

## Retention and protection

- Existing retention periods and `manual`, `quarantine`, `delete`, and `both`
  modes still apply. Quarantine moves session files and keeps database rows,
  so restoring a quarantined session remains possible.
- Only permanent deletion of an expired quarantined session authorizes removal
  of its exact thread ID from its own account's databases. `both` does not
  immediately delete newly quarantined sessions.
- The preview includes linked row counts, blocked candidates and pending work.
  Results report rows deleted, retries deferred and database file size reduction.
  Row deletion alone does not mean the filesystem has reclaimed that space.
- Current bot threads, cached threads, running Codex IDs, pinned threads,
  parent/child-linked threads, non-terminal turns and changed/restored sessions
  are protected. If the running-process check fails, cleanup stops.
- The default Codex home and registered managed account homes are supported.
  Managed sessions are quarantined under separate account subdirectories.
  Removed/unregistered accounts are not processed by pending retries.

## Supported databases

The helper recognizes `state_5.sqlite` and `thread_history_1.sqlite`, checks
required columns, and deletes only allowlisted thread tables. It rejects
unknown versions, unrecognized thread tables/relationships or trigger bodies, symlinks,
hardlinks and owner mismatches. Unknown schemas require a reviewed adapter
update; do not rename databases to make them appear supported.

Sessions without database rows can still be cleaned up. History rows without
a matching state row and original rollout path are protected. This feature
does not sweep arbitrary orphaned rows, logs or every database under Codex home.

## Crash recovery and compaction

Before deleting a payload, Cleanup fsyncs a small private receipt under
`CLEANUP_ARTIFACT_DIR/database-pending`. It contains IDs, paths and timestamps,
not conversation contents. Permanent deletion does not create payload backups.

If interrupted after file deletion, the next `delete` or `both` run retries the
receipt, rechecking protection and account binding. History is committed before
the state binding is removed. Database-only retries also run when no expired
files remain. Up to 256 deletion receipts are processed per run; excess work
remains pending. Do not delete pending receipts to dismiss an error.

Compaction has a separate durable retry marker. WAL checkpointing and VACUUM
are deferred when busy or when free disk space is insufficient. VACUUM requires
at least 64 MiB of free database pages and available disk space greater than
twice the database file size plus 1 GiB. Small amounts of free space remain
available for SQLite reuse. The helper checks database integrity after
compaction. A 120-second helper timeout retains retry state.

Manual `/cleanup` and scheduled Cleanup use the same implementation. Turning
the option off pauses database cleanup; existing pending receipts remain for
later recovery. Keep the option enabled until pending work is drained if you
intend to finish a migration. This is local maintenance under the bot's Unix
account, not isolation from other processes running under that same account.
