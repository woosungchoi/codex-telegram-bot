# CI-based dependency updates

On 2026-10-23 the repository owner authorized dependency PRs to merge automatically
when CI passes. This supersedes the earlier manually configured Codex commit and
package/lock approval hashes for the public workflows.

## Automatic path

1. The daily Codex updater selects stable pinned SDK/CLI versions and tests them
   on a read-only runner, without publication credentials or npm lifecycle scripts.
2. A fresh read-only runner validates the two JSON files. Only existing Codex
   SDK/CLI/platform lock entries may change, versions must increase within the
   current major, and package identities, integrity, download URLs, executable
   mappings and dependency/platform metadata must match fresh official npm JSON.
   Unrelated entries and root/lock metadata must remain unchanged. No package
   additions/removals, same-version mutations or lifecycle scripts are accepted.
3. The validator supplies exact file hashes as job outputs. These represent
   automatic policy validation, not human approval. The separate publisher
   rechecks both bytes and registry metadata without executing candidate code,
   then creates a same-repository `automation/codex-*` PR using the existing
   `CODEX_AUTOMATION_TOKEN` so normal PR CI is triggered.
4. `Dependency Auto Merge` runs after CI and every 15 minutes. It uses trusted
   `main` code, reads candidate files through GitHub's API, and revalidates the
   package policy. It merges only the latest eligible Codex PR, with all nine
   current-head checks successful: Node 18/20/22/24/26, Security audit, Integration
   coverage, Upload workflow data fixture, and Artifact transport compatibility.
   Checks must come from the GitHub Actions app; skipped required checks do not
   count. Additional failed or pending checks/statuses also block merging.
5. Behind branches are updated with an expected-head guard and wait for fresh CI.
   Immediately before squash merging, both the PR head and main are rechecked.
   Branch protection and administrator enforcement remain enabled. One PR is
   merged per reconciliation run.

Existing same-repository Dependabot npm patch/minor and same-major pinned GitHub
Actions updates remain eligible under their existing strict file/version policy.
General feature PRs, external forks, draft PRs, major upgrades, conflicts,
unsupported lock layouts and failed/incomplete checks remain for manual review.

## Operation and limits

No `CODEX_APPROVED_COMMIT`, `CODEX_APPROVED_PACKAGE_SHA256` or
`CODEX_APPROVED_LOCK_SHA256` repository variables are needed by these automatic
workflows. The similarly named publisher environment values now come only from
the separate validator's outputs, and are checked again before publication.
The legacy standalone manual validation path remains available.

Run **Codex Dependency Update** from Actions to check immediately, or wait for
its daily schedule. Run **Dependency Auto Merge** to reconcile already-open
eligible PRs. Candidate artifacts are retained for seven days. If registry data
cannot be verified, the update is held; no check or protection is bypassed.

This policy trusts the official npm registry's metadata and the repository CI;
it is not independent human review of upstream source. Changes to packaging
layout or executable behavior that exceed the supported policy require manual
review. Merging public package pins does not install them on the running private
bot, restart services, or change the local CLI updater's trust requirements.
