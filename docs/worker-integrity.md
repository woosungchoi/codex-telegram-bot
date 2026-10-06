# Worker integrity and dependency merge policy

## Framing and admission

Each RPC reader retains a UTF-8 decoder across chunks. Only newline-terminated
JSON frames are delivered; an unfinished frame at end/close produces one error.

One in-process admission lock covers reading the active index, checking the chat,
persisting the reservation, and registering the controller. Execution runs outside
that lock, so different chats still run concurrently. Live controllers also retain
chat reservations if the disk index is replaced while they are running.

Retrying a job ID with the same normalized request returns its persisted status
without starting another execution, including after completion or restart. A
different request with that ID, or an archived ID, requires a new ID. Failed
admission attempts leave a failed tombstone; use a new ID after addressing the
failure. IDs must contain 1–120 ASCII letters, digits, dots, underscores, colons or
hyphens to prevent filename aliases.

Admission failures run rollback before releasing the lock. Failed rollback blocks
new starts and healthy status responses until storage is repaired and the worker
is restarted. Startup reconstructs active reservations from job files, including
reservations interrupted before index registration, then records orphan failures.
It never re-executes orphaned work. Existing executions can still be queried or
cancelled while admission is blocked.

These locks assume one worker process owns a state directory. They do not provide
inter-process locking for multiple workers sharing the same files.

## Event log recovery

The newline-terminated JSONL prefix is the sequence ledger. The sparse reader
exposes its committed byte boundary, maximum sequence, ordering and last event.
Appending derives the next sequence from that ledger rather than cached job JSON.
State/status reads reconcile a stale `lastSeq` in memory; the next state write
persists it. Complete records with duplicate, decreasing or invalid sequences
block store replay/appends for explicit repair rather than silently skipping data.
A snapshot ahead of a truncated/missing log also blocks state reads and appends,
so sequence numbers cannot be reused below a persisted cursor. A start with
existing events but missing job metadata requires recovery and a new ID.

An interrupted trailing record, even parseable JSON without its newline, is not
delivered through the store. Before a new append, the original log is copied into
private quarantine and only then truncated to the committed prefix. Failure to
quarantine or trim propagates. Recovery can be interrupted and retried safely.

If append commits but state saving fails, `appendJobEvent` throws `EVENT_COMMITTED`
with `committedSeq`. The event remains replayable, and another append uses the next
sequence. Do not blindly retry the same event body: events have unique sequence
numbers, but arbitrary event bodies do not have a deduplication key. Job starts
have their separate request idempotency mechanism.

The existing file helpers close writes and atomically rename JSON snapshots but
do not call `fsync`. This recovery covers process interruption and injected I/O
failures with surviving filesystem data; it does not guarantee survival of OS or
power loss. No storage engine migration is included.

## Terminal state publication (1.4.2)

Terminal `worker.job.completed`, `worker.job.failed` and `worker.job.cancelled`
events are an exception to the ordinary log-first write path. Under the job lock,
the store first atomically saves the terminal status, `completedAt`, final cursor
and full `terminalEvent` in the job snapshot, then appends the JSONL record.
Delivery readers therefore never observe a newly committed terminal state without
its completion timestamp. Raw Codex turn events do not finish a worker job.

If the terminal append is interrupted, readers replay the final event from the
snapshot, including after a partial final line or an archive of the earlier log
prefix. Only the matching one-event-ahead terminal snapshot is accepted; unrelated
cursor/log divergence still requires explicit recovery. Late callbacks cannot
append events to this terminal state. This is process-interruption recovery, not
an `fsync` or power-loss guarantee. Drain work and delivery before worker upgrades.

## Read errors and quarantine

Only ENOENT represents absence. Permission and I/O errors propagate and block
admission/status instead of returning an empty active index. JSON syntax and
container damage are distinguished from I/O errors. A corrupt active index is
rebuilt only after every job file has been read and validated. Missing indexes
are also reconstructed, so an interrupted index write cannot hide existing jobs.

Quarantine creates a private snapshot without removing the source. Rename/copy or
permission failures are reported and prevent replacement. Corrupt job files keep
blocking repeated reads/writes until explicitly repaired from reliable evidence;
the original and quarantine copy remain available. Do not repair operational
files while a worker is writing them. There is no new automatic service restart.

## Dependency PR auto merge

The workflow checks out its trusted default-branch policy with credential
persistence disabled. Candidate PR files are read as data from immutable Git
commits; PR code and package scripts are never executed by the privileged merge
workflow.

- Dependabot requires its bot login, numeric user ID and Bot type. The Codex update
  branch requires either the GitHub Actions bot identity or the repository owner
  User identity, preserving the existing owner PAT updater. Other PAT identities
  require manual review. Both head repository ID and full name must match the
  base repository; external forks and branch-name impersonation are rejected.
- Package changes can alter only existing dependency version values. Scripts,
  metadata, additions/removals of dependency keys, Git/file specifications and
  unrelated Codex updater dependencies require manual review. Lockfile root
  metadata and manifest consistency are checked; resolved packages must use the
  npm public registry.
- Dependabot workflow changes can alter only action versions/SHAs in `uses` lines,
  preserving the action name and all surrounding content. Permissions, commands,
  triggers, added/deleted files and action substitutions require manual review.
- `Check Node 18/20/22/24/26`, `Integration coverage`, `Security audit`, and
  `Review PR` must succeed from GitHub Actions on the exact head SHA. Missing or
  skipped required jobs block merging. An optional reviewer step can still skip
  internally while its job succeeds, as in the existing review workflow.
- Immediately before merge, author, repository and head/base SHAs are checked
  again. `--match-head-commit` pins the inspected head at GitHub's merge boundary;
  uncertain API/merge outcomes fail the run. Success is reported only after
  GitHub confirms that head was merged. No administrator bypass is used.

Required check names are defined in `scripts/dependency-pr-policy.mjs`; update the
list when changing the CI matrix. This policy does not modify GitHub account
configuration, branch protection or rulesets.

## Validation

Run `npm run verify`, `npm run test:coverage` on Node 22+, and `actionlint`.
Focused tests are `worker_protocol`, `worker_store`, `worker_server`,
`worker_event_log`, `worker_log_retention` and `dependency_pr_policy` in `test/`.
They use temporary storage/sockets, fake executors and mocked Git/GitHub calls;
they do not merge a real PR, consume a real account or send Telegram messages.
