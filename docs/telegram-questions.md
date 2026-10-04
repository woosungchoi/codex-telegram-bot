# Telegram decision questions

Set `CODEX_INTERACTIVE_QUESTIONS=true` to enable the sidecar question bridge.
When enabled, main turns use the worker and app-server transport, even when the
saved transport setting is `sdk`. The global defaults remain unchanged.

The worker registers the local `telegram_questions.ask_decisions` MCP tool for
each job, including resumed threads. Supply an ordered list of questions with
stable IDs, question text and label/description options. Telegram displays one
question at a time, with lettered buttons, direct entry and cancellation. A
four-question batch waits for all four answers. The last answer returns the
answer map to the same tool call. Later questions can depend on earlier answers
by making another call. Recommendations never count as answers.

## Waiting and recovery

- This is a synchronous MCP request. The tool result is withheld until every
  question is answered. Required decisions must be requested before dependent
  actions; this cannot undo or suspend work already launched in other processes.
- Default-mode native `request_user_input` in CLI 0.159.3 is nonblocking. The
  bridge uses its own synchronous tool instead. Native blocking app-server
  questions are supported too; nonblocking native requests fail closed.
- Pending questions, accepted answers and their cursor live in the worker job
  file with private permissions. Bot restarts can redisplay the pending question;
  the worker and MCP connection continue waiting. Old buttons cannot advance an
  already answered question. Answers are bound to requester, chat/topic, job and
  unique request ID. Question UI is outside the final-delivery replay stream.
- Replies are routed before the ordinary turn queue. Buttons and A/B/C or 1/2/3
  select options; arbitrary text must reply to the question message. Secrets are
  not supported. Cancellation aborts the job instead of supplying an empty answer.
- There is no UI auto-selection timeout. MCP has a seven-day tool deadline;
  expiration is failure, never authorization. The sidecar heartbeat/polling loop
  does not treat human waiting as an idle model stream.
- A worker restart interrupts the live RPC. Preserve the question receipt and
  mark the job `question_interrupted`; do not automatically replay the task.
  The user must explicitly resume after checking the prior state. A fully
  answered receipt also blocks automatic restart recovery because delivery of
  that answer to the model may be uncertain.

## Deployment

Merge and validate before restarting. Drain active jobs and final delivery,
restart the worker and bot, then enable the flag in both services. The worker
advertises `questions-v1`. Do not restart a worker that has a pending decision.

Tests cover sequential questions, identity checks, duplicate replies,
cancellation, durable state, frontend reconnection and worker interruption.
A read-only live Codex smoke test confirmed four answers before completion.
