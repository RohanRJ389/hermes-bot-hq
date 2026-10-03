# The Home contract

A **Home** is a bot's dashboard. The bot owns the data; Bot HQ owns
the structure. That split is the whole design: a bot can refresh its numbers
every morning without permission, but it cannot invent new UI on every load,
so the page stays something you can learn once and trust.

## Operator buttons

A Hermes bot is purpose-built. It does a small, known job — research,
writing, monitoring, ops — and the user's next steps on that job are also
small and known. Chat is the right interface when the next sentence is
unpredictable. A Home is the opposite: the bot already did the work, the
page already shows it, and the next step is one of a few named moves the
user repeats. Clicking is the product working. Retyping that into the
composer every day is the product failing.

The composer stays for the exception: a novel ask that is not worth a
declared button. A monitoring bot (review / mark genuine / escalate) is one
illustration, not the scope — any specialist dashboard that is an ops
console for a fixed task uses the same pattern.

Label and prompt live in `schema.json`. Daily values live in `data.json`.
A line click concatenates the schema prompt with that item's id and title
so the agent knows which row. Prompts never belong in `data.json`.

## Where it lives

Two files inside the bot's own profile directory:

```text
~/.hermes/profiles/<bot>/home/schema.json    # layout — changes rarely
~/.hermes/profiles/<bot>/home/data.json      # values — rewritten by runs
```

The `default` profile uses `~/.hermes/home/` instead, since that profile *is*
the Hermes home.

A Home that uses `run_action` buttons also has `home/actions/` (the bot's
scripts) and `home/actions.jsonl` (the click log). See
[Run actions](#run-actions).

No registration call, no database. A bot joins Bot HQ by writing
`schema.json`; a bot without one still appears in the fleet with status,
routines, and a chat link.

Write atomically — write a sibling temp file and `rename()` it over the target.
A half-written `data.json` is a parse error, and the page will say so.

## schema.json

```json
{
  "version": 1,
  "title": "Research Desk",
  "subtitle": "Semis coverage, refreshed each morning",
  "composer": false,
  "toolbar": [
    { "id": "brief", "label": "Run now", "type": "run_routine", "job": "morning-brief", "primary": true },
    { "id": "notes", "label": "Open notes", "type": "open_path", "path": "~/research/notes.md" }
  ],
  "widgets": [
    { "id": "snapshot", "type": "kpi", "title": "Snapshot", "width": "full" },
    { "id": "compare", "type": "table", "title": "NVDA vs AMD" },
    { "id": "risks", "type": "alerts", "title": "Open risks" },
    { "id": "cites", "type": "sources", "title": "Sources" }
  ]
}
```

| Field | Rules |
| --- | --- |
| `version` | Integer. `1` today. An unknown version still renders; the page notes it. |
| `title` | Optional, <= 80 chars. Defaults to the bot's Bot Mode title. |
| `subtitle` | Optional, <= 160 chars. |
| `composer` | Optional bool, default `false`. `true` adds one input on the page. |
| `toolbar` | Optional, <= 8. Page-level buttons, always above the widget stack. |
| `actions` | Alias for `toolbar`. Existing Homes keep working; no migration. |
| `widgets` | <= 24. Order is render order. `id` must be unique, `[a-z0-9_-]`. |

`width` is `full` or `half` (default `half`); `full` spans the page. An optional
`empty` string is shown when `data.json` has nothing for that widget yet.

### Buttons

The same button object is used on the toolbar, on a `buttons` widget, and
on `list` / `alerts` lines. Named operations, never a shell command:

| `type` | Extra field | Effect |
| --- | --- | --- |
| `run_routine` | `job` | Triggers that cron job for this bot, then refreshes |
| `open_chat` | - | Opens the bot's conversation in Hermes |
| `open_path` | `path` | Reveals a file or folder in Finder / Explorer |
| `open_url` | `url` | Opens `http`/`https` in the default browser |
| `send_prompt` | `prompt` | Sends that text to the bot's Bot Chat, then refreshes |
| `run_action` | `script`, optional `notify` | Runs `home/actions/<script>` with no chat turn, then applies its result |

`prompt` is required, stripped, max 4000 characters. `job` matches a cron
job by id, or by name (with or without Bot Mode's `[bot:<name>]` prefix).
`script` is a file name, not a command: 1-64 characters matching
`^[a-z0-9][a-z0-9_-]{0,63}$`, so no dots, slashes, or spaces. See
[Run actions](#run-actions). One button may set `primary: true`.

If both `toolbar` and `actions` are present and disagree, `actions` wins so
an upgraded Home never loses its existing strip.

A `buttons` widget places the same controls in the card stack (no
`data.json` payload). `list` and `alerts` widgets may declare `buttons` in
schema; each item in `data.json` lists ids only:

```json
{ "id": "api-2-disk", "title": "disk full on api-2", "buttons": ["genuine", "escalate"] }
```

Item `id` must be `[a-z0-9_-]` and unique in that widget when `buttons` is
set. Missing id means no line buttons (a warning, not an unreadable Home).
Unknown ids are dropped. At most 3 buttons per line. On a line click, Bot
HQ appends `[item id]` and `[item title]` (alerts use `message` as the
title). Optional `{{item.id}}` / `{{item.title}}` in the schema prompt are
substituted first. `table`, `kpi`, `markdown`, `timeseries`, and `sources`
do not get line buttons.

## Run actions

A `run_action` button does a fixed side effect — ignore a row, send an
email, write a database entry — without a model turn. The bot writes the
program once; every click runs it.

```text
~/.hermes/profiles/<bot>/home/actions/<script>   # bot writes, executable
~/.hermes/profiles/<bot>/home/actions.jsonl      # Bot HQ appends, bot reads
```

```json
{ "id": "ignore", "label": "Ignore", "type": "run_action", "script": "ignore" }
```

The button's `id` is what a `data.json` line lists. Its `script` is the file
Bot HQ runs. Any language works: Bot HQ executes the file itself, so it
needs a shebang (`#!/usr/bin/env python3`, `#!/bin/bash`, ...) and the
executable bit. A file that resolves outside `home/actions/` (for example
through a symlink) is refused.

**Input.** One JSON object on stdin:

```json
{
  "bot": "monitor",
  "button": "ignore",
  "widget": "issues",
  "item": { "id": "api-2-disk", "title": "disk full on api-2", "detail": "92% used", "tone": "bad" }
}
```

`widget` and `item` are `null` for a toolbar click, and `item` is `null`
for a `buttons` card. `item` is the validated row as Bot HQ shows it; the
page sends only ids, and Bot HQ looks the row up itself. The script runs
with its working directory set to `home/` and `HERMES_HOME` set to the
bot's profile.

**Output.** One JSON object on stdout:

```json
{ "ok": true, "hide": true, "message": "Ignored" }
```

| Field | Effect |
| --- | --- |
| `ok` | Required. Anything but `true` is a failure; the row stays as it is. |
| `hide` | Remove the clicked row from the page. |
| `patch` | Replace display fields on the row: `title`, `detail`, `tone` on a list line; `message`, `detail`, `level` on an alert. Other keys are dropped. |
| `message` | Shown as a toast, max 200 characters. |

A run that exits non-zero, prints anything but one JSON object, prints more
than 64 KiB, or takes longer than 30 seconds is a failure. Failures are
logged too.

**Approval.** A script does not run until the user has read and accepted
its current contents. The first click on a new or changed file shows the
file on the bot's page with an **Approve** control; later clicks run
straight away. Approvals are stored by Bot HQ outside the bot's Home, keyed
by a hash of the file, so editing the file asks again.

**The log.** Every click appends one line to `home/actions.jsonl`:

```json
{"seq": 41, "ts": "2026-08-29T07:02:11Z", "widget": "issues", "item": "api-2-disk", "button": "ignore", "script": "ignore", "result": {"ok": true, "hide": true, "patch": {}, "message": "Ignored"}}
```

`seq` only increases. Bot HQ applies `hide` and `patch` from every
successful event newer than `acked_seq` (see `data.json`) on top of your
data when it serves the page, so a hidden row stays hidden even before you
next rewrite `data.json`.

On your next run: read the log, skip lines that do not parse (a click may be
mid-append), fold every event with `seq > acked_seq` into your own state,
rewrite `data.json` to match, and set `acked_seq` to the highest `seq` you
handled. Bot HQ never edits `schema.json` or `data.json`; `actions.jsonl` is
the only file it writes.

`notify: true` on the button also sends one short message to the bot's
Bot Chat after a successful run, so the bot handles the log now instead of
on its next routine. Leave it off for clicks that only need recording.

## data.json

```json
{
  "updated_at": "2026-08-29T06:15:00Z",
  "stale_after_minutes": 1440,
  "note": "AMD Q2 filing not out yet",
  "widgets": {
    "snapshot": {
      "items": [
        { "label": "NVDA rev growth", "value": "+56%", "delta": "+4pp", "tone": "good" },
        { "label": "AMD rev growth", "value": "+9%", "tone": "neutral" }
      ]
    },
    "compare": {
      "columns": ["Metric", "NVDA", "AMD"],
      "rows": [["Gross margin", "75%", "49%"], ["Fwd P/E", "31", "27"]]
    },
    "risks": {
      "items": [{ "level": "warn", "message": "Reporting periods are not aligned" }]
    },
    "cites": {
      "items": [{ "title": "NVDA 10-Q", "url": "https://example.com/10q", "fetched_at": "2026-08-29T06:02:00Z" }]
    }
  }
}
```

`updated_at` is an ISO-8601 timestamp; it drives the "updated 20m ago" line.
`stale_after_minutes` (default 1440) decides when a Home is flagged **Stale**,
which is how a dead routine becomes visible instead of a dashboard quietly
showing last week's numbers as if they were current.

`acked_seq` (integer, default `0`) is the highest `home/actions.jsonl`
event this data already reflects. Events at or below it are not overlaid.

## Widget payloads

Types are a closed set. An unknown type renders as a skipped chip rather than
executing anything — a bot cannot ship HTML or JavaScript through this file.

| `type` | Payload | Caps |
| --- | --- | --- |
| `kpi` | `items: [{ label, value, delta?, tone? }]` | 12 items |
| `table` | `columns: [str]`, `rows: [[cell]]` | 12 columns, 200 rows |
| `list` | `items: [{ id?, title, detail?, tone?, url?, buttons? }]` | 200 items |
| `markdown` | `text: str` | 20,000 chars |
| `timeseries` | `series: [{ label, points: [[x, y]] }]` | 6 series, 500 points |
| `sources` | `items: [{ title, url?, fetched_at? }]` | 100 items |
| `alerts` | `items: [{ id?, level, message, detail?, buttons? }]` | 50 items |
| `buttons` | none (schema `buttons` only) | 8 buttons |

`tone` is `good`, `warn`, `bad`, or `neutral`. `level` is `info`, `warn`, or
`error`. `markdown` renders as paragraphs and bullet lines only — no HTML.
`points` take a number or an ISO-8601 string for `x` and a number for `y`.

Either file may be up to 512 KiB. Over that, the page reports the file as
unreadable instead of loading it: a dashboard is a summary, and a bot that
wants to hand over a dataset should link to it with `open_path`.

## What the page does with a broken Home

Nothing silently. A parse error, a bad type, or a missing widget payload
surfaces as a warning on the bot's page and as **Home unreadable** on its
fleet card, so the failure is visible where the data would have been.
