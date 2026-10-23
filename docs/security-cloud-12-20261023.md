# Security hardening and migration — October 23, 2026

This change addresses twelve reviewed findings against public main `b3f305d`.
These are code changes and regression checks, not a claim of a fresh external
scan or closure of Security Cloud findings.

| Finding | Change |
| --- | --- |
| 1. Persisted request authorization | Preserve versioned bot, requester, account and chat/topic provenance through queues, journals, worker jobs and recovery. Recheck current policy before execution, recovery and delivery. Quarantine incomplete or revoked requests. |
| 2. Reviewer credential exposure | Disable the optional credentialed PR reviewer. No OAuth-bearing agent is executed. This mitigates the exposure by removing the execution path, not by claiming same-UID credential isolation. |
| 3. Topic collisions | Authorize explicit chat/topic pairs instead of globally reusable topic numbers. |
| 4. Cross-conversation sessions | Bind sessions to bot/account/chat-topic in a host-owned registry; filter list/read/resume paths and check both transports before resume. |
| 5. Aggregate uploads | Enforce total stored bytes and filesystem free space during streaming under a cross-process kernel lock. Count crash leftovers on the next admission. |
| 6. Image attachment ownership | Allow only host-created, current-turn output directories. Host-register regular files and send bounded bytes copied from validated descriptors. |
| 7. Audit soft success | Keep bounded retries, but fail after an unavailable audit. A successful exit without a complete audit report cannot pass. Keep Security audit required by the merge policy. |
| 8. Paired update approval | Require an independently approved digest of the entire lock graph, including CLI/platform integrity and executable metadata. Run staged verification only inside bubblewrap isolation with a read-only project mount; unsupported isolation blocks updates. Recheck approval before activation. |
| 9. Dashboard cancellation | Check the requester and authoritative scheduled-task owner before aborting or cancelling a job. Missing or different owners cannot be cancelled. |
| 10. Reviewer executable provenance | Remove the credentialed, version-only CLI installation/review path together with finding 2. Re-enabling requires a separately reviewed isolation and artifact-provenance design. |
| 11. Automatic publication/merge trust | Require independent exact package/lock file hashes for PR publication. Exclude Codex SDK/CLI changes, including lock-only/platform metadata changes, from automatic merging through every source. |
| 12. Mutable Actions | Pin all external Actions to full commit SHAs and reject mutable updates in the merge policy. |

## Configuration and stored data

- Use `ALLOWED_TOPIC_BINDINGS='[["-100123",17],["-100456",17]]'`. Empty means
  unrestricted topics. Legacy `ALLOWED_THREAD_IDS` works only with exactly one
  allowed chat; ambiguous or mixed configurations fail at startup.
- Sessions are shared among currently authorized participants of the same
  chat/topic. Other chats, topics, accounts and bots cannot resume them. Existing
  files remain intact; unknown historical ownership is never inferred. Ordinary
  conversations start a fresh session when the saved session has no owner record.
- A local account administrator can review a historical session's actual owner
  and explicitly register it. Existing registrations cannot be reassigned:

  ```sh
  node scripts/import-session-owner.mjs --confirm-owner=yes --user-id=ADMIN \
    --chat-id=CHAT --chat-type=private --account-id=default --session-file=/absolute/session.jsonl
  # Forum destinations also use --chat-type=supergroup --topic-id=17
  ```

- Legacy queue/recovery records missing provenance remain preserved and blocked.
  A quarantined item at the front can hold the queue; review it and submit a new
  authorized request or explicitly clear the item. Do not fill in a requester
  automatically from the destination chat ID.
- Upload defaults are 5 GiB (`UPLOAD_QUOTA_BYTES`) and 1 GiB minimum free space
  (`UPLOAD_MIN_FREE_BYTES`). A full quota rejects new uploads without deleting
  old data. Admissions are serialized, with a 120-second lock wait. Keep
  `.upload-quota.lock` outside cleanup candidates; crash partials remain charged.
- Image output must use the fresh path supplied in the turn's prompt. Old
  workspace paths and other turns' paths cannot become attachments merely by
  appearing in model text. The capability lasts 24 hours and recovery retains
  only its original turn's capability. Files are not automatically deleted.

## Independent approvals and isolation

`CODEX_UPDATE_TRUST_FILE` must include `artifacts[].sdk.lockSha256`, computed by
`dependencyGraphDigest()` from recursively key-sorted JSON of the complete lock.
It covers the SDK, CLI, optional platforms, integrity, bin entries and dependency
relationships. A checksum obtained from the candidate registry is not itself an
independent approval. Keep the existing independently approved CLI archive digest.

The publisher uses repository variables `CODEX_APPROVED_PACKAGE_SHA256` and
`CODEX_APPROVED_LOCK_SHA256`: SHA256 of the exact original file bytes, managed
outside the candidate artifact/PR. These differ from the canonical lock digest.
Codex changes require an explicit maintainer merge decision even after CI passes.

The dependency update workflow validates candidates in a separate read-only job
before starting the credentialed publisher. Missing approval is reported as
`awaiting-approval`; valid hashes for different bytes are reported as
`awaiting-new-approval`. Both leave publication skipped, without failing the
scheduled test run. Malformed configured hashes or invalid candidate data still
fail. The publisher retains its strict exact-byte approval check before any API
writes, including when approval changes after the read-only check.

The run summary records the tested SDK/CLI versions and both candidate hashes.
Download the `package-update` artifact (retained for seven days), independently
review the complete package/lock diff and provenance, and only then set the two
repository variables above to the reviewed file hashes. Re-run the workflow;
a different regenerated candidate needs fresh review. Never populate approval
variables automatically from the test job or its artifact. Successful tests and
an overall green run alone do not mean that packages were published or upgraded.

Paired updates require Linux bubblewrap with usable mount, PID and network
namespaces. Verification cannot fall back to host execution. A separate HOME or
filtered environment does not prevent another same-UID process reading host
files; normal trusted full-access agent execution retains that limitation.

## Validation scope

Tests cover revoked/missing identities, topic collisions, session ownership,
concurrent streaming and process death, cross-turn attachments, cancellation
ownership, lock tampering, missing approval, unavailable audits and immutable
Actions. Existing positive-path and rollback tests remain. Actual isolated
update success requires a host supporting the namespaces; unsupported-host
failure is separately tested before npm or candidate execution.
