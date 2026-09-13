# Maintaining feature boundaries

`src/runtime.js` owns startup and service wiring. `runtime/route_composition.js`
registers the real Telegram routes; `runtime/execution_composition.js` connects
execution, worker delivery and recovery. Keep these explicit composition roots.
Feature modules receive the capabilities they need instead of importing runtime.

## Workspace controllers

`workspace/controller.js` registers routes and composes projects, sessions, tasks,
MCP and dashboard controllers. Each controller owns its actions and input stages.
`workspace/capabilities.js` exposes chat, execution, settings and Telegram access;
`workspace/contracts.d.ts` documents the controller interfaces. The new controller
modules use JSDoc with `@ts-check`; runtime and persisted record internals remain
JavaScript and are not comprehensively typed. Extend these interfaces when adding
a dependency. Do not import a sibling controller to call its private functions.

`npm run typecheck` checks these boundaries. `npm run check:architecture` checks
static local imports and re-exports for cycles, feature imports of runtime, and
workspace controller coupling. It does not analyze dynamic imports. Format the
files listed in `npm run format:source` when touching this maintained surface.

## Menus and translations

`ui/menu_definition.js` owns the panel parent tree and rendering rules. Give new
buttons an explicit `role` (`action`, `back` or `close`); workspace controllers
should use `ui.back(type, args)`. UI-only metadata is stripped before Telegram
receives a keyboard. Callback payloads remain compatible with existing messages.
Legacy factories and saved keyboards are adapted at the renderer boundary; do not
add more label-based navigation checks in controllers.

Messages live in `src/locales/*.json`, including `accounts.*`, `workspace.*` and
`forum.*`. Domain message helpers are compatibility adapters to the same catalog.
`npm run validate:locales` checks keys, strings, nonempty translations and named
placeholders. Add the same key and placeholders to every locale.

## Verification

- `npm run verify`: syntax, locales, lint, formatting, type boundaries,
  architecture, tests and the repository's dependency audit policy.
- `npm run test:coverage` (Node 22+): integration coverage, LCOV and
  `coverage/summary.json`. CI uses Node 24 and uploads the artifacts. Unreported
  source files are listed separately, so a percentage cannot hide untested
  entrypoints. Both composition modules must have executed lines.
- `test/runtime_routes_integration.test.mjs`: real Telegraf middleware and route
  composition with a fake Telegram API; navigation, authorization, account usage,
  input interruption and expiration.
- `test/runtime_execution_integration.test.mjs`: both transports and worker modes
  using fake backends, including interrupted delivery. Transport implementations
  also have dedicated tests. No live account or Telegram message is needed.

## Saved state

Runtime state now has `schemaVersion: 1`; workspace and forum namespaces each have
`version: 1`. `state/schema.js` accepts unversioned data as version 0, fills absent
containers and checks their shapes before startup. Future versions and malformed
containers raise an error; the source file is not overwritten by a failed load.
Unknown extension fields are retained. This validates container contracts, not
every field of every historical task or provider payload.

Only expired account and workspace UI flows are removed during load. Scheduled
tasks, project presets, forum bindings/jobs, queue entries, worker deliveries and
`accountResetAttempts` are durable. In particular, uncertain reset requests must
survive prompt expiration to prevent duplicate consumption. Domain controllers
still enforce ownership, topic binding and their existing prompt lifetimes.

Saving remains serialized and atomic with private file permissions. Back up the
operational state before deployment. Migration is in memory until the next save;
version 1 adds metadata without changing durable record formats. For rollback,
stop the service before restoring its matching code/state backup, and reconcile
external actions completed after that backup before allowing retries.

## Comparing private and public repositories

Use reviewed file copies or patches in a checkout based on the public branch.
Never merge private deployment history into a public branch. Keep deployment
extensions, operational documentation and credentials out of public commits.

`node scripts/repository-sync.mjs <private-ref> <public-ref> <manifest.json>` checks
all tracked file modes and blob IDs. The manifest has `version: 1`, an optional
`metadataPath` excluding only the manifest itself, and `differences` entries with
`file`, `privateBlob`, `publicBlob` and `reason`. Blob values use Git's
`<mode> <type> <object-id>` format; an absent file uses `null`. Store the manifest
and private/public commit mappings in private operational metadata. The public
repository ships the checker, not a private deployment's manifest.

Review every difference before recording its exact blob IDs. A later change even
inside an approved file fails the check and needs another review. Resolved entries
also fail until removed. The checker never pushes, refreshes approvals or prints
file contents. It complements a secret scan and public-branch verification; an
allowlist by itself is not proof that a public release is safe.
