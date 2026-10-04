# Telegram steering

Steering is enabled by default (`CODEX_STEERING=true`). Chats/topics without a
saved queue mode default to `steer`; existing saved modes remain unchanged.
Choose a mode in the desired chat/topic:

- `/steer` (also `/queue_mode_steer` or `/queue mode steer`) sends subsequent
  messages to the current task automatically. The mode is saved for that chat/topic.
- `/queue_mode_safe` queues follow-ups and offers an explicit steering button.
- `/queue` shows both mode buttons; `/queue_mode` shows the current mode.

The `/steer` command changes the mode only; it does not submit a Codex prompt,
interrupt the task, or replay existing queued messages. With no active task,
messages start normally. While paused, restarting, recovering, or waiting for
final delivery, follow-ups remain queued. If steering is disabled or the worker
job is not yet known, they also remain queued.

The feature selects sidecar worker and direct app-server transport; restart both
services after upgrading. Set `CODEX_STEERING=false` to disable steering and
queue follow-ups normally. Existing `.env` files with that explicit setting keep
steering disabled until changed to `true`. `/steer` selects the chat mode; it
does not override the environment setting.

In safe mode, ordinary follow-ups enter the durable queue. If the original worker job is
already known when the message arrives, its acknowledgement and `/queue` show
**Apply to current task**. Pressing the button (or sending a follow-up in steer mode) transfers prepared input to
that exact job's active thread/turn through `turn/steer`, including reply context
and images. It never targets a newer job or starts another Codex turn.

- Pending interactive decisions must be answered first.
- An accepted input is removed from the queue; API acceptance is not proof that
  the model has finished implementing it.
- A definite rejection leaves it queued for normal next-turn execution.
- An uncertain delivery keeps a durable queue hold. It never expires or retries
  automatically. The queue inspection button reuses the same request ID and
  checks the saved receipt. If uncertainty remains, inspect the original task,
  then explicitly cancel the held item or submit a new corrective request.
- Duplicate clicks use one receipt. The worker validates chat/topic, requester,
  job, payload hash and current turn identity. Receipts are private worker state.
- Worker restarts with steering history require explicit recovery; replaying only
  the original prompt could discard corrections. Frontend-only restart keeps
  the active worker's steering channel and receipts.
- Steering is applied when Codex can consume new input. It cannot roll back
  commands or external actions already started.
- Messages arriving before the worker job is known are still queued normally.
  Side and interrupt modes keep their existing behavior.

Validation covers active-turn JSON-RPC routing, RPC delivery, identity and
cross-topic rejection, repeated requests, lost acknowledgements, question
priority, queue hydration, expiry and final-turn races. A read-only live Codex
smoke verifies a changed final answer with exactly one `turn/started` event.
