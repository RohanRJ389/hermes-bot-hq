---
name: bot-home
description: Publish and maintain your own dashboard (your "Home") in Bot HQ. Use when asked to build, show, update, or fix your dashboard, interface, or fleet page, and at the end of a routine whose findings belong on it.
---

**Skill name:** `hermes-bot-hq:bot-home` — use this qualified name in cron
jobs (`skills` / `--add-skill`) and when calling `skill_view`. The bare name
`bot-home` is not loadable.

# Publish your Home

Your Home is the dashboard the user sees when they open Bot HQ
and click you. It exists so they can check on your work without reading a chat
transcript.

You maintain it by writing two JSON files. Nothing else is required — no
registration, no tool call, no asking permission.

```text
<your profile dir>/home/schema.json   # the layout. Write once, change rarely.
<your profile dir>/home/data.json     # the values. Rewrite every run.
```

Your profile dir is your `HERMES_HOME` (run `hermes profile path` if unsure).
Create `home/` if it does not exist.

## The one rule that matters

**Write atomically.** Write a temp file next to the target, then rename it:

```bash
python3 - <<'PY'
import json, os, pathlib
home = pathlib.Path(os.environ.get("HERMES_HOME", "")) / "home"
home.mkdir(exist_ok=True)
payload = {"updated_at": "...", "widgets": {}}   # your real data
tmp = home / "data.json.tmp"
tmp.write_text(json.dumps(payload, indent=2))
os.replace(tmp, home / "data.json")              # atomic
PY
```

The dashboard may read while you write. A plain `>` redirect can be caught
half-written, and the user sees "Home unreadable" instead of your work.

## Division of labor

You own the **data**. The plugin owns the **structure**.

That means the widget vocabulary is fixed and small. You cannot add a widget
type, ship HTML, or run JavaScript through these files — anything unrecognized
renders as a "skipped" chip. This is deliberate: the user learns your dashboard
once, and it does not rearrange itself every morning.

If your work genuinely needs something the vocabulary lacks, say so in chat and
propose the widget. Do not work around it by stuffing a table into markdown.

## schema.json

```json
{
  "version": 1,
  "title": "Research Desk",
  "subtitle": "What I'm tracking, refreshed each morning",
  "composer": false,
  "toolbar": [
    { "id": "brief", "label": "Run now", "type": "run_routine", "job": "Researcher Digest", "primary": true }
  ],
  "widgets": [
    { "id": "snapshot", "type": "kpi", "title": "Snapshot", "width": "full" },
    { "id": "findings", "type": "list", "title": "Today's findings" },
    { "id": "cites", "type": "sources", "title": "Sources" }
  ]
}
```

- `widgets`: up to 24. Render order is array order. `id` must be unique and
  lowercase (`[a-z0-9_-]`). `width` is `half` (default) or `full`.
- `toolbar` (or `actions` — same strip): up to 8 page-level buttons, always
  above the cards. Types: `run_routine` (needs `job`), `open_chat`,
  `open_path` (needs `path`), `open_url` (needs `http(s)` `url`),
  `send_prompt` (needs `prompt`), `run_action` (needs `script`).
- `run_action` runs a script you wrote in `home/actions/` with no chat turn —
  use it for a fixed side effect the user will click often (ignore, send,
  record). `send_prompt` is for clicks that need your judgment. Recipe and
  script skeleton: `buttons.md`.
- Need a clickable move the user will repeat? Read `buttons.md` in this skill
  folder. If unsure, put page-level clicks on `toolbar`. Composer still works.
- Do not put `prompt` in `data.json`. Do not rebuild schema every run.
- `composer: true` adds a single input on your page so the user can prompt you
  without opening a chat. Set it only if a prompt is genuinely part of using
  your dashboard — most bots should leave it `false`.

## Widget types

| type | payload in `data.json` | limits |
| --- | --- | --- |
| `kpi` | `items: [{ label, value, delta?, tone? }]` | 12 |
| `table` | `columns: [str]`, `rows: [[cell]]` | 12 cols, 200 rows |
| `list` | `items: [{ id?, title, detail?, tone?, url?, buttons? }]` | 200 |
| `markdown` | `text: str` (paragraphs and `-` bullets only) | 20,000 chars |
| `timeseries` | `series: [{ label, points: [[x, y]] }]` | 6 series, 500 points |
| `sources` | `items: [{ title, url?, fetched_at? }]` | 100 |
| `alerts` | `items: [{ id?, level, message, detail?, buttons? }]` | 50 |
| `buttons` | none — declare `buttons` on the widget in schema | 8 |

`tone` is `good` / `warn` / `bad` / `neutral`. `level` is `info` / `warn` /
`error`. A `timeseries` `x` is a number or an ISO-8601 timestamp.

## data.json

```json
{
  "updated_at": "2026-08-29T06:15:00Z",
  "stale_after_minutes": 1440,
  "note": "One AMD filing still missing",
  "widgets": {
    "snapshot": { "items": [{ "label": "New launches", "value": "6", "tone": "good" }] },
    "findings": { "items": [{ "title": "…", "detail": "…", "url": "https://…" }] },
    "cites": { "items": [{ "title": "…", "url": "https://…", "fetched_at": "2026-08-29T06:02:00Z" }] }
  }
}
```

Every key under `widgets` must be a widget id your `schema.json` declares —
data for an undeclared id is reported as a problem, not rendered. Set
`updated_at` on every write; the page shows it, and if it ages past
`stale_after_minutes` (default 1440) your dashboard is flagged **Stale** so a
dead routine is visible rather than quietly serving last week's numbers.

## Habits

- **Read your click log first.** If you have `run_action` buttons, start each
  run by reading `home/actions.jsonl`, handle every event with `seq` above
  your `acked_seq`, then write `data.json` with the new `acked_seq`. Details
  in `buttons.md`.
- **Update at the end of a routine.** If a scheduled run produced findings, the
  same run should rewrite `data.json`. A dashboard that only refreshes when
  asked is worse than no dashboard.
- **Keep it a summary.** Cap the top items and link the rest with `open_path`
  or a `sources` entry. Both files together are limited to 512 KiB each.
- **Say what is missing.** Use `note` or an `alerts` entry when a source failed
  or data is partial. Silence reads as confidence.
- **Do not rebuild the layout every run.** Touch `schema.json` only when what
  you track actually changes.

Full reference: `docs/home-contract.md` in the `hermes-bot-hq` plugin. Copy-paste
button recipes: `buttons.md` in this skill folder.
