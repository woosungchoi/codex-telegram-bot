# Codex update panel

Open **Tools → Codex Maintenance → Codex update**. The button is below report
and backup. Opening it checks the installed CLI, installed SDK and latest stable CLI release without
installing anything. An authorized administrator sees **Start update** when a
newer CLI or independently approved SDK is available (including SDK-only drift). Refresh updates the progress view; the detached
operation edits the original update panel with the final result, including after
bot restarts. Its bot/chat/topic/message identity is saved before launch. No
separate completion message is sent; pending buttons are removed on completion.

## Supported runtime

The automatic path supports Linux with user systemd, `curl`, `git`, `npm`, and `flock`,
using the official standalone installation in `CODEX_UPDATE_HOME`. The configured
`CODEX_PATH` (or the underlying configured CLI) must resolve to a symlink into that home's
`packages/standalone/releases`. Other installations show an explanation and use
their original package manager; this feature never replaces an npm/Homebrew
installation. The bot service's working directory must match the running repo.

- `CODEX_UPDATE_HOME`: canonical host home, default `~/.codex`; independent of
  an account-specific `CODEX_HOME`.
- `CODEX_UPDATE_BIN`: underlying standalone command for a custom wrapper.
  The bundled `codex-yolo` wrapper resolves `CODEX_REAL_PATH` automatically
  (including an override in `CODEX_ENV_JSON`). Wrapper and actual CLI versions
  must agree. Wrapper contents and execution flags are preserved.
- `CODEX_UPDATE_ADMIN_USER_IDS`: must be in `ALLOWED_USER_IDS`; defaults to
  `CODEX_ACCOUNT_ADMIN_USER_IDS`, or the sole allowed user. Multiple allowed
  users without configured administrators get a read-only panel.
- `CODEX_UPDATE_BOT_SERVICE`, `CODEX_UPDATE_WORKER_SERVICE`, and
  `CODEX_UPDATE_APP_SERVER_SERVICE`: user systemd unit names. Worker restart is
  required in sidecar mode; the external app-server restarts only if active.

## Operation

1. Previews expire after ten minutes and bind to the actor, chat/topic, message,
   installation, and displayed target version. The target cannot be supplied
   through arbitrary callback text.
2. A host lock serializes bot update requests. The detached systemd service also
   holds the standalone installer's native `install.lock` using `flock`.
3. Download the exact independently approved CLI archive and verify its digest
   before extracting or executing it. No remote installer script is executed.
   The same trust entry must contain `sdk.version` and `sdk.integrity` (npm
   sha512 SRI), reviewed independently of the update download. The SDK version
   can differ from the CLI version when explicitly approved. Missing SDK trust
   fails closed rather than silently performing a CLI-only update.
   Copy regular tracked files from a Git checkout without source changes to a private
   `.codex-update-deps/run-<id>/project` directory; never copy `.env`, `.npmrc`,
   state or account credentials. Update only the SDK and CLI development package
   pins and reject unrelated lockfile changes. Check the approved SDK integrity
   before `npm ci --ignore-scripts`. Run `npm run verify` and an SDK import smoke
   check with an isolated HOME and filtered environment. npm lifecycle install
   scripts are disabled. Preparation errors leave running services unchanged.
4. New jobs pause at `waiting_idle`. Messages remain queued, including interrupt
   and side modes. The updater requires a recent bot idle acknowledgement, no
   active/side turns or unsent final responses, and an idle worker for five
   continuous seconds. The wait is bounded to thirty minutes; timeout fails
   without cancelling jobs. The bot stops briefly and worker idle is checked
   again before selection.
5. Recheck the Git revision, manifests and installed SDK before applying.
   The original command/current links and native auto-update selection marker
   are saved before switching. Existing native auto-update eligibility is preserved. Required
   services stop for dependency activation: persist the transaction, retain the
   old node_modules tree and manifests, then install the verified tree and files.
   Services restart, CLI/SDK versions and worker connectivity are checked, and the
   running external app-server executable must match the target version.
   After worker restart, a read-only status handshake retries transient socket
   startup errors for up to thirty seconds before restarting the bot. A spawned
   systemd process alone does not prove the socket is ready; permanent errors
   still fail immediately and genuine startup failure triggers rollback.
6. Verification failure restores the old CLI links, node_modules and both package
   manifests before restarting services. After an interrupted
   switch, **Recover update** restores the persisted original selection rather
   than repeating uncertain activation. Preparation can resume if selection had
   not begun. Failed restoration keeps admission paused and retains the lock.

Models, reasoning effort, account profiles, sessions, databases and `.env` are
preserved. Older release directories remain available for rollback. Update state,
per-run results and notification receipts live under `codex-update` next to
`STATE_FILE`; runtime artifacts are never committed. Staging is removed after
terminal outcomes; only a small dependency verification log remains. A failed/uncertain notification must be reconciled using its
receipt; never repeat an update just to repair the panel. If the original message
was deleted or cannot be edited, record the edit failure without creating a new
message. Older runs without a saved panel message ID require explicit recovery
of that ID; their completion is never sent to a newly created message.

The global host lock is under
`CODEX_UPDATE_HOME/packages/standalone/.telegram-update-lock`. If another bot
instance owns it, inspect its recorded `owner.json` and state rather than deleting
the lock. An updater stopped by systemd can be recovered from the panel once its
service is inactive. Rollback covers binary selection, SDK dependencies, package manifests and service activation;
it does not attempt to reverse runtime data migrations performed by a CLI.

For a code deployment that must reload the worker safely, a local operator can
write `deployment-pause.json` in the update state directory with a unique `id`
and a bounded numeric `expiresAt` (epoch milliseconds). Admission pauses and the
same bot idle reporter acknowledges this ID. Remove the marker after activation;
expiry also resumes admission. This marker does not represent a CLI update and
does not alter the update outcome or model settings.

Official installation reference: [Codex CLI](https://learn.chatgpt.com/docs/codex/cli).

## Repository and package-manager boundaries

The paired updater requires a Git checkout with dev dependencies and tests,
plus sufficient space for a second dependency tree. It refuses tracked runtime
secrets, symbolic source files and a symlinked node_modules. npm-only installations
must update their package through their original deployment process. Do not run
another npm install or deploy while the update owns its lock.

Successful runtime updates change package.json and package-lock.json in the local
checkout. Review and commit those exact changes through your normal source workflow;
the updater does not automatically commit or push code. Only local modifications
to those two manifests are accepted at preparation, so subsequent paired updates
can proceed; other tracked changes block preparation. Manifest hashes are
rechecked before activation. Public dependency PR
publication remains the separate reviewed GitHub workflow. A standalone CLI
upgrade performed outside this bot does not invoke this paired updater.

Rollback copies are retained until a terminal success or rollback is persisted;
an uncertain/failed rollback retains them and the admission lock. Recovery after
an interrupted selection restores the original pair, including a crash between
moving the old and new node_modules directories. Pre-selection retries replace
only that run's staging directory. A process killed just after a terminal outcome
can finish cleanup through the same run; never manually delete recovery backups
while an operation is nonterminal.
