# Buttons

A Hermes bot is purpose-built: a fixed job, so a fixed set of next steps.
Declare a button when the user will do this again. Do not invent a new
widget type. Do not put `prompt` in `data.json`.

`toolbar` (or `actions` — same strip) is the page-level row above the cards.
A `buttons` widget sits in the stack like any other card. Line buttons sit
on a `list` or `alerts` item.

## Pick the button type

Ask, for each move the user repeats on this page:

1. Does it need you to read, decide, or write something new?
   Use `send_prompt`. Examples: "Investigate", "Draft a reply", "Review".
2. Could a script do all of it from the row and the files you already have?
   Use `run_action`. Examples: "Ignore", "Mark genuine", "Send digest",
   "Log to DB".
3. Is it a script job, but you should also react right away?
   Use `run_action` with `"notify": true`. Example: "Escalate" that pages
   on-call and also wants you to follow up.
4. Re-run your whole job? Use `run_routine`.
   Go somewhere? Use `open_url`, `open_path`, or `open_chat`.

Prefer `send_prompt` when the click is rare (weekly or less), or when the
script would need credentials or tools you cannot reach from a plain
program. Each new or edited script needs the user's approval once, so a
script only pays off when it is clicked often.

A script runs without you. It cannot call the model, your tools, or MCP.
It has what is on disk and in its environment. If the move needs any of
those, it is case 1.

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
        { "id": "review", "label": "Review", "type": "send_prompt", "prompt": "Review the findings on this dashboard and update Home when done." }
      ]
    }
  ]
}
```

No `data.json` entry for `triage`. Review means reading the whole page and
deciding what matters — judgment, so `send_prompt`.

## 2. Buttons on a list line

The control sits on the line. Schema declares the verbs; each item only names ids.

```json
{
  "id": "findings",
  "type": "list",
  "title": "Issues",
  "width": "full",
  "buttons": [
    { "id": "genuine", "label": "Genuine", "type": "run_action", "script": "genuine" },
    { "id": "investigate", "label": "Investigate", "type": "send_prompt", "prompt": "Investigate this issue, write up what you find, and update Home." }
  ]
}
```

```json
{
  "items": [
    { "id": "api-2-disk", "title": "disk full on api-2", "detail": "92% used", "buttons": ["genuine", "investigate"] },
    { "id": "payments-timeout", "title": "timeout on payments", "buttons": ["investigate"] }
  ]
}
```

Genuine only records a verdict, so a script does it (recipe 3 shows how).
Investigate needs you to dig in, so it is a prompt.

Give every item with `buttons` an `id` (`[a-z0-9_-]`). Skip the id and that line has no buttons — the Home still publishes. Same pattern on `alerts` (title is `message`). At most 3 buttons per line.

On a `send_prompt` line click, Bot HQ appends `[item id]` and `[item title]` even if the prompt is just `investigate`. You may also use `{{item.id}}` and `{{item.title}}` in the schema prompt.

## 3. A button that runs a script (no chat turn)

Use `run_action` for cases 2 and 3 of the chooser. Every `send_prompt`
click costs a model turn and makes the user wait; a `run_action` click
does not.

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

**Hide or patch.** Hide only when the row is resolved and should leave the
page (Ignore). When the row stays but changed, patch it instead — a Send
email script returns:

```json
{ "ok": true, "patch": { "detail": "Sent to on-call", "tone": "good" }, "message": "Email sent" }
```

**Write it to be safe.**

- Make it safe to run twice for the same row id — skip the insert or the
  email if that id was already handled.
- Load credentials from files in your profile. Do not assume an environment
  variable is set; the script does not run inside your session.
- Return `ok: false` with a `message` when something fails, rather than
  printing a traceback.

**Test it before you tell the user.** Pipe a sample click in yourself:

```bash
echo '{"bot":"me","button":"ignore","widget":"issues","item":{"id":"x","title":"t"}}' \
  | "$HERMES_HOME/home/actions/ignore"
```

It must print one JSON object and exit 0. Then tell the user in chat: the
first click shows them the file and asks them to approve it. Until they do,
the button does nothing, and any edit to the file asks again.

## 4. Reading the click log

Every `run_action` click is appended to `home/actions.jsonl`. **The script
already did the work. Do not repeat it** — re-sending the email or
re-inserting the row is the bug this log exists to prevent. Use it to
update what you remember and what you show.

On every run, before you rewrite `data.json`:

1. Read `home/actions.jsonl` (one JSON object per line; skip a line that does
   not parse).
2. Take each event whose `seq` is above the `acked_seq` in your current
   `data.json`. `item` is the row id, `button` is what they clicked,
   `result` is what your script returned.
3. Update your own state: stop raising an ignored issue next run, note an
   escalation, keep a verdict.
4. For `result.ok: false`, fix the script or add an `alerts` row saying the
   click failed — the user may think it worked.
5. Rewrite `data.json` to match — drop resolved rows, keep changed ones as
   they now are — and set `"acked_seq"` to the highest `seq` you handled.

`notify: true` messages you right after a successful click, so you do this
now instead of on your next run. Leave it off when the next run is soon
enough.

Full rules: `docs/home-contract.md` in the `hermes-bot-hq` plugin.
