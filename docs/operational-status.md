# Optional operational status

`/ops` displays an operator-provided JSON snapshot. It is disabled by default:
no menu entry and no file reads until `OPERATIONAL_STATUS_FILE` is configured.
Typing `/ops` while disabled returns a setup hint. The existing bot user, chat,
and topic allowlists apply; every allowed conversation can view the same snapshot.
Use a dedicated bot/allowlist if the data should have a narrower audience.

## Setup

1. Have your existing monitoring job write a regular UTF-8 JSON file atomically
   (temporary file followed by rename). Keep it owned by the service operator,
   use restrictive permissions, and make its parent directory trusted.
2. Set `OPERATIONAL_STATUS_FILE` to its absolute path in `.env`, then restart
   the bot frontend. Symbolic links and non-regular files are rejected on Linux.
3. Send `/ops`. UI labels follow the bot language; timestamps follow its current
   locale and time zone settings. Service names, messages and metric values are
   displayed as supplied, with HTML escaped.

The bot only reads the file. It does not run collector commands, connect to
monitoring APIs, schedule polling, or store credentials. Put only information
you intend to share with the bot's allowed conversations in the snapshot.

## Snapshot format (schema 1)

```json
{
  "schema": 1,
  "checkedAt": "2026-10-06T00:00:00Z",
  "services": [
    {
      "name": "Website",
      "status": "ok",
      "checkedAt": "2026-10-06T00:00:00Z",
      "metrics": [
        { "label": "Requests (last 15 minutes)", "value": 1200 },
        { "label": "Cache hit rate", "value": "82.4%" }
      ]
    },
    {
      "name": "Backups",
      "status": "warning",
      "message": "Restore verification has not run yet.",
      "metrics": [
        { "label": "Retained archives", "value": 5 },
        { "label": "Restore result", "value": null }
      ]
    },
    {
      "name": "Cloudflare analytics",
      "status": "unknown",
      "reason": "permission_missing"
    }
  ]
}
```

- Required: `schema: 1`, `checkedAt`, and `services` (0–16 entries).
- Each service requires `name` (1–100 characters) and `status`:
  `ok`, `warning`, `error`, or `unknown`.
- Optional service fields: `checkedAt`, `message` (up to 500 characters),
  `reason` (`permission_missing` or `query_failed`), and `metrics` (0–16 entries).
- Each metric requires `label` (1–100 characters) and `value`: string (up to
  500 characters), finite number, boolean, or `null` for an unknown value.
  Units and measurement windows belong in labels/values; missing evidence must
  not be represented as a successful result or numeric zero.
- Timestamps must include seconds and `Z` or a numeric UTC offset. A snapshot
  or service timestamp over 30 minutes old, or in the future, gets a warning.
  Set per-service timestamps when collectors refresh at different intervals.
- Input is limited to 128 KiB, including reads during concurrent writes. Invalid
  data produces a localized warning without exposing file paths or parser errors.
- Output is limited to one message (3,500 HTML characters). Whole lines are
  omitted with a notice when necessary; use concise metrics and put critical
  services first. String lengths use JavaScript UTF-16 units.

Cloudflare is an example of an external collector, not a built-in integration.
It can report aggregate traffic, cache metrics, or a permission error using the
same schema. Backup retention, domains, node names, and collection schedules
remain choices of the operator.
