# Security report follow-up (2026-10-08)

The supplied report contains ten historical static findings against public commit
`0d6aa8b5e37f7cd353d5c0bfb4145a30f96e91ec`. This change hardens the public 1.4.3 codebase. It is not a new Security Cloud scan
or a claim that exploitation occurred.

| Finding                                             | Current treatment                                                                                                                                                                                                                                                  |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1: CI log prompt injection into authenticated agent | Removed credentialed CLI diagnosis entirely. Deterministic log classification, redacted evidence, comments and artifacts remain.                                                                                                                                   |
| 2: direct transport controls                        | Map network/search/write-root controls into native session and turn policies; enforce explicit Git checks locally, let search disable win, fail closed on incompatible network denial, and replace stale write roots.                                                               |
| 3: snapshot races                                   | Entire per-directory read/modify/write serialized in the sole bot writer; completion tombstones reject late updates, explicit replacement begins a new turn, mismatched job/queue updates are rejected.                                                            |
| 4: worker authority                                 | Every RPC authenticates before dispatch. Worker-generation credential rotates on startup. Question MCP receives only a signed, expiring job-bound question capability. Same-UID sandboxed execution is rejected instead of claiming isolation it does not provide. |
| 5: frame exhaustion                                 | 8 MiB byte limit before decoding, bounded fragment storage, 30-second incomplete-frame/idle connection deadlines, 64 connections, one request per connection.                                                                                                      |
| 6: attachment buffering                             | Stream bytes into a private file, enforce actual and declared limits, abort and unlink partial downloads. Four concurrent downloads, two-minute deadline and 1 GiB hard ceiling (lower configured ceilings apply).                                                 |
| 7: unlimited side turns                             | Acquire capacity before preparing inputs: one side reply per chat and four total, released on failure/completion; 30-minute execution abort deadline.                                                                                                              |
| 8: upload symlinks                                  | Random exclusive no-follow files, opened relative to a verified Linux directory descriptor; reject symlink parents and moved upload roots.                                                                                                                         |
| 9: photo symlinks                                   | Resolve roots and validate the opened descriptor; at most five 10 MiB photos. Send bounded validated byte copies, never reopen model-selected paths.                                                                                                               |
| 10: group backups                                   | Full backup creation and delivery require private chat plus explicit `BACKUP_ADMIN_USER_IDS`. Empty means nobody. Restore payload and chat-specific export remain unchanged.                                                                                       |

## Deployment compatibility

The worker protocol now requires authentication. Restart bot and worker together;
old clients cannot communicate with a new worker. The credential is a private
`<worker socket>.auth` file. Never expose it through diagnostic output or model
configuration. The question capability permits only `question/ask` for its active
job, expires after seven days and is invalidated by worker restart.

A private file or bearer credential **does not isolate mutually distrusting
processes running as the same OS user**. Sidecar generation now requires an
explicitly trusted `danger-full-access` operator configuration and rejects narrower
per-chat policies. Do not enable full access
merely to bypass this refusal. Sandboxed deployments must use inline execution
with the sidecar stopped, or implement a separate-UID/mount-isolated executor.
This patch does not supply such an executor. Keep the sidecar stopped when using
inline execution for sandboxed workloads with `CODEX_STEERING=false` and
`CODEX_INTERACTIVE_QUESTIONS=false`; a running same-UID worker remains a
privileged service even if the bot uses inline execution.

Descriptor verification and anchored upload creation currently require Linux
`/proc/self/fd`; unsupported platforms fail closed. They do not silently fall back
to race-prone path reopening. Upload cleanup still sees ordinary files in the
configured upload directory. Download capacity overflow returns an error and
requires a new request; it does not automatically replay input.

Only the bot writes recovery snapshots in this architecture. The in-process
mutex does not make multiple independent bot instances sharing one state file
safe. The separate worker job store and delivery receipts retain their existing
recovery and idempotency rules. This change does not promise exactly-once external
side effects.

## Validation

Offline fixtures cover concurrent different-chat snapshot updates, tombstones,
IPC size/deadline/UTF-8 handling, unauthenticated live local socket requests,
question capability method/job/expiry scope, streamed over-limit cancellation,
upload parent symlinks, post-validation photo replacement, group/private backup
authorization, side-turn burst capacity and direct transport policy handling.
No real secret extraction, Telegram group backup transmission, or model-driven
exploit is used as a test. Local Codex 0.160.1 generated protocol schemas confirm
`SandboxPolicy` supports `networkAccess` and `writableRoots`; runtime sandbox
isolation is not inferred from a schema alone.
