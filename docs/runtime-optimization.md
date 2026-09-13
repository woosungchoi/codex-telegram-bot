# Runtime performance and worker log retention

Startup uses Telegraf's identity-ready launch callback to schedule saved queues;
long polling continues to run. Shutdown or launch failure cancels the scheduled
queue startup. Queue, account/reset, and final-delivery transitions still save
immediately.

Worker event reads keep bounded sparse byte indexes (64 logs, up to 1,024
checkpoints each), without retaining event payloads or file descriptors. The
first read validates the log; subsequent reads scan new bytes. Atomic file
replacement and truncation rebuild the index. Logs are append-only: maintenance
or external tools must replace files atomically instead of rewriting their middle.
Incomplete trailing records are retried; malformed completed records still fail.
Older sequence cursors remain replayable.

Streaming delivery cursors checkpoint at each page boundary, at 250 ms intervals
between processed events, and at account, first-activity, thread, error, and
terminal boundaries. Recovery item snapshots coalesce for 250 ms and flush with
the next critical snapshot/iterator close; individual journal events remain.
A crash can replay the uncheckpointed suffix. It cannot skip the durable
result-ready/sending/sent transitions used to prevent duplicate final delivery.

Usage queries cache for five seconds; session API queries for three seconds.
Concurrent identical queries share work. Cache keys include the account home and
authentication file identity/mtime. Explicit Refresh bypasses cached results;
login, account administration and reset redemption invalidate usage reads.
Resuming a session always reads current status. Session titles cache bounded
results against account-confined real paths and file metadata; no image/tool or
hidden-reasoning data becomes a title.

Workspace/forum container versions are checked on access. Full record validation
runs on load and before atomic state saves, so invalid direct mutations cannot
overwrite the last valid file. The state schema version remains 1.

## Worker archives

`CODEX_WORKER_LOG_RETENTION_DAYS=30` enables hourly archival, starting one minute
after worker startup. `0` disables the automatic schedule. Each run archives at
most 20 files. The default CLI operation is a read-only preview:

```bash
node scripts/worker-log-maintenance.mjs --dry-run
node scripts/worker-log-maintenance.mjs --apply
```

Run from the configured bot directory with the worker online. Manual commands use
30 days when automatic archival is disabled. Both return counts and byte totals.

Eligibility requires a completed job **and** a confirmed Telegram delivery
receipt bound to its job identity, sequence and chat. Both completion and delivery
must be older than the retention period. Active jobs, queued recoveries, recovery
snapshots/restart markers, and ambiguous/pending/failed deliveries are protected.
Unreadable or malformed protection files stop archival. Old logs without delivery
proof remain untouched; file age alone is never sufficient.

Receipts are recorded after the sent ledger is saved. The worker can also capture
receipts from remaining sent ledger entries before those entries expire. A failed
receipt write never causes a second Telegram send. Keep both bot and worker on a
compatible version to retain these confirmations reliably.

Eligible logs are streamed into private gzip files in the worker `archives/`
directory, decompressed and SHA-256 checked, then published atomically. The
original is removed only after another identity/protection check. Job metadata
retains the archive location and digest; the same worker event API can replay the
archive and validates its digest. Archived job IDs cannot be reused. Archives
and job metadata have no automatic deletion policy. Back up the whole worker
state directory, including `jobs/` and `archives/`.

For rollout, merge verified changes before restarting the bot. Let current jobs
finish before restarting the worker; the bot and worker have separate lifecycles.

## Reproducible measurements

`npm run benchmark:runtime` generates temporary 1/8/32 MiB logs and workspace
fixtures, measures warm-index EOF polling and state access, counts cursor saves,
and checks startup with real Telegraf polling against a fake API. It makes no
network requests and removes its temporary data. Results are synthetic local
measurements, not Telegram latency or cold-index performance guarantees.
