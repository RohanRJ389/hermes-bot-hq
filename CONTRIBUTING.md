# Contributing to Bot HQ

Issues and pull requests are welcome. The license is MIT; there is no CLA.

If something in setup or the page confused you, that is a useful PR — this
plugin is meant to be easy to turn on.

## Work from a clone

```bash
git clone https://github.com/the-spirit-realm/hermes-bot-hq.git ~/.hermes/plugins/hermes-bot-hq
```

Then do [README steps 2–4](README.md#set-up): enable **Bot HQ** in Desktop
Plugins, `hermes plugins enable hermes-bot-hq`, fully quit Hermes and reopen.

The desktop page hot-reloads when `desktop/plugin.js` is saved (`Cmd+K` ▸
**Reload desktop plugins** if not). Changes under `dashboard/` need a backend
restart — those routes mount at startup.

## Where to change what

| You are changing | Start here | Tests |
| --- | --- | --- |
| Fleet page, bot detail, empty Home prompt | `desktop/plugin.js` | `tests/*.test.mjs` |
| Home validation, REST, run-routine | `dashboard/plugin_api.py` | `tests/test_home_validation.py` |
| What bots are taught | `skills/bot-home/SKILL.md` (+ `buttons.md`) | keep [`docs/home-contract.md`](docs/home-contract.md) in sync |
| Example dashboard | `examples/` | — |

The Python half reads and validates Home files and runs approved
`run_action` scripts. It never writes `schema.json` or `data.json`; it only
appends the click log `home/actions.jsonl`. Bots publish by writing
`home/schema.json` and `home/data.json` in their own profile.

## Guardrails

These are the design, not leftover constraints:

- The bot owns **data**. This plugin owns **structure**.
- Widget types are a closed set. A new type is a real contribution (schema,
  renderer, skill, contract, tests). Shipping HTML or JavaScript through a
  Home is not. The user learns one set of moves per bot; that is why the
  vocabulary stays small — a purpose-built bot has a fixed job, not a new
  UI every morning.
- Buttons are the named verbs (`run_routine`, `open_chat`, `open_path`,
  `open_url`, `send_prompt`, `run_action`). A declared `prompt` is allowed,
  and so is a `script` that names a file in `home/actions/`; a shell command
  string, HTML, or a prompt inside `data.json` is not. A script runs only
  after the user approves its current contents. The top strip is
  `toolbar` (`actions` is the same list, kept so upgrades do not blank
  existing Homes).

## Tests

From the plugin directory:

```bash
node --test "tests/*.test.mjs"

PYTHONPATH=~/.hermes/hermes-agent \
  ~/.hermes/hermes-agent/venv/bin/python -m unittest discover -s tests
```

The Python suite is stdlib `unittest`. Run it with the Hermes venv; there is
nothing extra to pip-install.

## Good first work

- **Easier setup.** Two switches, a backend restart, and a yellow banner if
  you miss one — anything that makes the first-run path shorter or obvious.
- **Blinking avatars.** Fleet cards and the bot page show the face, but the
  eyes stay still. In Hermes Desktop those faces blink. Make Bot HQ do the
  same, without copying the whole Bot Mode face renderer.
- **A better home in Hermes.** Bot HQ is a sidebar page plus a palette
  command. If it belongs on the main dashboard, in a tab, or somewhere
  people already look, propose it.
- **Web view.** Bot HQ only runs inside Hermes Desktop. The Home reader is
  already HTTP. Make the same fleet and bot page usable in the Hermes web
  view, not as a separate site.
- **Another example Home.** `examples/` is one research-desk pair. A second
  complete `schema.json` + `data.json` for a different kind of bot (still
  only the closed widget types) is a good first PR — keep `examples/README.md`
  in sync.
- **A new closed widget type** — if a real bot cannot say what it needs with
  the current set.

Open an issue if you are unsure whether an idea fits. Better a short
conversation than a PR that has to fight the contract.
