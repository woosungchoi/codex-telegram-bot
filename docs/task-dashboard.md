# Task dashboard and input receipts

A task starts with one pinned dashboard containing **Check receipt**, **Changed
files**, and **View result** buttons. Before worker admission these buttons explain
that the task is preparing. File/result previews stay inside the same card, with a
Back button; long previews are bounded and clearly marked. Pinning failures fall
back to an ordinary message.

Execution, input receipt, and final Telegram delivery are separate:

- **Not sent**: the input has not yet been submitted to Codex.
- **Not checked yet** / **Awaiting input acknowledgement**: no positive receipt
  has been observed, or submission is in progress.
- **Receipt confirmed**: the worker has persisted a native acknowledgement.
- **Uncertain**: receipt lookup or interrupted submission cannot establish
  delivery. The bot does not automatically resend uncertain input.
- **Completed result verified**: an already completed result was found.

The app-server worker persists a native client message ID before `turn/start` and
an acknowledgement afterwards. The frontend reads this evidence automatically,
including when reattaching after a restart. A temporary lookup failure cannot
erase an existing acknowledgement. Other transports without native receipts may
remain unchecked until their completed result is available.

`/progress` inspects the latest job belonging to the requester in the current
chat/topic. `/recovery` can verify the stored account, thread, turn and client
message ID through read-only history. Inspection never starts or resubmits a
turn. Worker startup recovers only an already completed matching input; missing
or uncertain evidence remains held. Buttons also enforce requester and exact
message/chat/topic scope, including scheduled jobs.

Native plan, aggregate diff and token snapshots feed the dashboard. Changed-file
views are bounded; the standalone diff download is capped at 200,000 characters.
The existing live-commentary preference remains separate from the dashboard.

Only confirmed final-answer delivery removes the whole dashboard and its buttons.
Execution success alone does not remove it, and Telegram API acceptance does not
prove that a person read the answer. Failed or uncertain final delivery stays
visible. Failed deletion persists for retry, including after restart, and late
button responses cannot recreate an already completed card.
