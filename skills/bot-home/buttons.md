# Buttons

A Hermes bot is purpose-built: a fixed job, so a fixed set of next steps.
Declare a button when the user will do this again. Do not invent a new
widget type. Do not put `prompt` in `data.json`.

`toolbar` (or `actions` — same strip) is the page-level row above the cards.
A `buttons` widget sits in the stack like any other card. Line buttons sit
on a `list` or `alerts` item. If unsure, only do recipe 1.

## 1. Button card in the stack

```json
{
  "version": 1,
  "title": "Research Desk",
  "toolbar": [
    { "id": "digest", "label": "Run digest", "type": "run_routine", "job": "Researcher Digest", "primary": true }
  ],
  "widgets": [
    { "id": "findings", "type": "list", "title": "Findings", "width": "full" },
    {
      "id": "triage",
      "type": "buttons",
      "title": "Triage",
      "width": "full",
      "buttons": [
        { "id": "review", "label": "Review", "type": "send_prompt", "prompt": "Review the findings on this dashboard and update Home when done." },
        { "id": "escalate", "label": "Escalate", "type": "send_prompt", "prompt": "Escalate genuine open issues on this dashboard (email the owning team) and update Home." }
      ]
    }
  ]
}
```

No `data.json` entry for `triage`. Review here means the whole page, not one row.

## 2. Buttons on a list line

The control sits on the line. Schema declares the verbs; each item only names ids.

```json
{
  "id": "findings",
  "type": "list",
  "title": "Issues",
  "width": "full",
  "buttons": [
    { "id": "genuine", "label": "Genuine", "type": "send_prompt", "prompt": "Mark this issue genuine and update Home." },
    { "id": "escalate", "label": "Escalate", "type": "send_prompt", "prompt": "Escalate this issue (email the owning team) and update Home." }
  ]
}
```

```json
{
  "items": [
    { "id": "api-2-disk", "title": "disk full on api-2", "detail": "92% used", "buttons": ["genuine", "escalate"] },
    { "id": "payments-timeout", "title": "timeout on payments", "buttons": ["escalate"] }
  ]
}
```

Give every item with `buttons` an `id` (`[a-z0-9_-]`). Skip the id and that line has no buttons — the Home still publishes. Same pattern on `alerts` (title is `message`).

On a line click, Bot HQ appends `[item id]` and `[item title]` even if the prompt is just `escalate`. You may also use `{{item.id}}` and `{{item.title}}` in the schema prompt.

## 3. A button that runs a script (no chat turn)

Use `run_action` when the click is a fixed side effect the user repeats —
ignore an issue, send an email, insert a row. Every `send_prompt` click costs
a model turn and makes the user wait; a `run_action` click does not.

Schema: same button shape, with `script` instead of `prompt`. `script` is a
file name in `home/actions/` — lowercase letters, digits, `-`, `_`, no dot.

```json
{
  "id": "issues",
  "type": "list",
  "title": "Open issues",
  "width": "full",
  "buttons": [
    { "id": "ignore", "label": "Ignore", "type": "run_action", "script": "ignore" },
    { "id": "escalate", "label": "Escalate", "type": "run_action", "script": "escalate", "notify": true }
  ]
}
```

`data.json` lines list button ids exactly as in recipe 2.

The script: `home/actions/ignore`, executable, any language with a shebang.
It reads the click on stdin and prints one JSON result on stdout:

```bash
mkdir -p "$HERMES_HOME/home/actions"
cat > "$HERMES_HOME/home/actions/ignore" <<'PY'
#!/usr/bin/env python3
import json, sys

click = json.load(sys.stdin)          # {"bot", "button", "widget", "item"}
item = click.get("item") or {}

# Do the real work here: write a DB row, send mail, append to a file.

json.dump({"ok": True, "hide": True, "message": f"Ignored {item.get('id', '')}"}, sys.stdout)
PY
chmod +x "$HERMES_HOME/home/actions/ignore"
```

Result fields: `ok` (required, `true` on success), `hide` (drop the row),
`patch` (replace `title` / `detail` / `tone` on a list line, or `message` /
`detail` / `level` on an alert), `message` (toast). Exit 0. Finish within 30
seconds.

After you create or edit a script, tell the user in chat: the first click
shows them the file and asks them to approve it. Until they do, the button
does nothing.

On every later run, before you rewrite `data.json`:

1. Read `home/actions.jsonl` (one JSON object per line; skip a line that does
   not parse).
2. Handle each event whose `seq` is above the `acked_seq` in your current
   `data.json`: `item` is the row id, `button` is what they clicked,
   `result` is what your script returned.
3. Rewrite `data.json` to match — drop ignored rows, update changed ones —
   and set `"acked_seq"` to the highest `seq` you handled.

`notify: true` (Escalate above) also messages you right after the click
succeeds. Leave it off when the log on your next run is soon enough.

Full rules: `docs/home-contract.md` in the `hermes-bot-hq` plugin.
