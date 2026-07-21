# Architecture

Codex Telegram Bot connects authorized Telegram chats to Codex through either
the Codex SDK or the local app-server transport. The runtime also supports an
optional sidecar worker for durable turn execution.

## Startup and request flow

```text
src/bot.js
  -> src/runtime.js                         composition root
       -> src/config.js                     validated flat configuration
       -> runtime state and domain factories
       -> runtime/execution_composition.js  turn, worker, and recovery graph
       -> runtime/route_composition.js      Telegram route registration
       -> app/bootstrap.js                  directories, schedulers, signals, launch

Telegram update
  -> authorization middleware
  -> command, callback, or message router
  -> queue and turn controller
  -> inline Codex executor or sidecar worker
  -> delivery journal
  -> Telegram response
```

`src/bot.js` is intentionally only an executable entrypoint. Importing
`src/runtime.js` initializes the application. `src/runtime.js` is a composition
root: it creates shared state, constructs domain controllers, injects their
capabilities into other controllers, registers routes, and hands lifecycle
startup to `bootstrapBot`. It does not implement Telegram handlers, settings
flows, cleanup inventory, or recovery algorithms directly.

## Composition boundaries

- **Lifecycle:** `src/app/bootstrap.js` prepares private directories, installs
  process signal handlers, starts schedulers and recovery, launches Telegraf,
  and resumes persisted queues.
- **Configuration:** `src/config.js` is a compatibility facade over the readers
  in `src/config/`. Telegram, Codex, recovery, maintenance, path, and runtime
  settings are validated in their own modules and merged into the established
  flat configuration object.
- **Execution:** `src/runtime/execution_composition.js` connects the Codex
  executor, turn controller, live progress, worker runtime, recovery journal,
  and restart recovery controller through narrow injected interfaces.
- **Routing:** `src/runtime/route_composition.js` wires authorization and the
  command, callback, and message routers. Concrete handlers live under
  `src/telegram/`; the composition module only maps capabilities to routers.
- **Telegram transport:** `src/telegram/` owns context normalization, uploads,
  reply formatting, API fallback behavior, command menus, and route handlers.
- **UI:** `src/ui/` owns panels, keyboards, model selection, settings callbacks,
  and presenters. Stable facade modules compose smaller selection, settings,
  operations, resolver, and presenter modules while preserving callback data.
- **Queue and turns:** `src/queue/` owns persisted queue policy and runtime queue
  operations. `src/codex/turn_controller.js` owns prepared-turn execution and
  chooses inline or sidecar execution through injected capabilities.
- **Recovery:** `src/recovery/runtime_controller.js` coordinates restart and
  inline startup recovery. Worker job resume and final delivery live in
  `worker_runtime_controller.js`; worker delivery ledger transitions live in
  `worker_delivery_journal.js`.
- **Maintenance:** `src/maintenance/` owns backup, cleanup, and Codex maintenance.
  Cleanup inventory, scheduling, and Telegram UI are separate modules composed
  by `cleanup_runtime.js`.
- **Diagnostics:** `src/status/runtime_diagnostics.js` composes data collectors
  and Telegram HTML presenters rather than reading runtime globals.
- **Worker:** `src/worker/` owns the sidecar protocol, store, server, replay,
  delivery classification, and runtime polling controller.

## Dependency direction

The intended dependency direction is inward from the composition root:

1. `runtime.js` may import and instantiate domain factories.
2. Composition modules may connect factories through small capability objects.
3. Routers and controllers receive state, persistence, transport, timing, and
   formatting functions as dependencies.
4. Domain modules must not import `runtime.js` or reach into its local variables.
5. Facade modules preserve stable exports while implementation modules stay
   grouped by one responsibility.

This keeps behavior testable without launching Telegraf and prevents route,
cleanup, recovery, or presentation changes from becoming runtime-global edits.
The line count of `runtime.js` alone is therefore not a signal to move wiring
into arbitrary helpers; executable domain logic belongs in the owning module,
while explicit construction and dependency mapping remain in the composition
root.

## State and durability

Runtime state is local and must not be committed. It includes:

- chat options and bound Codex thread ids;
- persisted pending queues and queue modes;
- downloaded Telegram images and PDFs;
- worker jobs and Telegram delivery ledger entries;
- active-turn recovery snapshots, restart markers, and recovery journals;
- cleanup plans, quarantine metadata, artifacts, and backups; and
- Codex sessions and maintenance handoffs.

Persistent files and directories are created with private permissions. Queue
state allows pending messages to survive a restart. Recovery snapshots track
in-flight work, while the worker delivery ledger separately records whether a
sidecar result is ready, sending, failed, or sent. This separation prevents an
ambiguous Telegram request from being automatically delivered twice.

## Message and queue behavior

Registered Telegram commands are routed to command handlers. Unknown
slash-prefixed text such as `/home/user/project` is ordinary input so paths can
be sent naturally. Photos and image documents become Codex `local_image`
inputs; PDF references are retained as text context. Reply context and eligible
replied-to images are merged into the prepared turn.

Queue modes are:

- `safe`: enqueue behind the active turn;
- `interrupt`: request cancellation and put the new turn first; and
- `side`: run an isolated side turn without replacing the active thread.

## Compatibility and verification

Telegram callback strings, persisted state shapes, configuration keys, and the
exports of facade modules are compatibility boundaries. Refactors should add
characterization tests before moving logic, keep these boundaries unchanged,
and run the normal syntax, lint, format, test, audit, and package checks after
composition changes.
