# Contributing to Bot HQ

Issues and pull requests are welcome. The license is MIT; there is no CLA.

If something in setup or the page confused you, that is a useful PR — this
plugin is meant to be easy to turn on.

## Work from a clone

```bash
git clone https://github.com/the-spirit-realm/hermes-bot-hq.git ~/.hermes/plugins/hermes-bot-hq
```

Then follow the [README setup steps](README.md#set-up) (steps 2–4) so you are running your checkout.

The desktop page hot-reloads when `desktop/plugin.js` is saved (`Cmd+K` ▸
**Reload desktop plugins** if not). Changes under `dashboard/` need a backend
restart — those routes mount at startup.

## Layout

```text
hermes-bot-hq/
├── plugin.yaml            # agent half — ships the skill + the setup command
├── __init__.py            # register(ctx): registers skills/ and `hermes hermes-bot-hq`
├── setup.py               # `hermes hermes-bot-hq setup` — onboard every bot in one step
├── skills/bot-home/       # how a bot publishes its dashboard
├── dashboard/
│   ├── manifest.json      # tab hidden: this plugin's UI is the desktop half
│   └── plugin_api.py      # reads + validates Home JSON, triggers routines
├── desktop/plugin.js      # the Bot HQ page (plain ESM, no build step)
├── docs/home-contract.md  # the data contract
├── examples/              # a complete schema.json + data.json pair
└── tests/                 # node:test for the UI, unittest for the reader
```

The Python half exists because the gateway has no file-read RPC and a disk plugin may only import `@hermes/plugin-sdk`. `plugin_api.py` reads and validates Home files. It never writes them.

## Where to change what

| You are changing | Start here | Tests |
| --- | --- | --- |
| Fleet page, bot detail, empty Home prompt | `desktop/plugin.js` | `tests/*.test.mjs` |
| Home validation, REST, run-routine | `dashboard/plugin_api.py` | `tests/test_home_validation.py` |
| What bots are taught | `skills/bot-home/SKILL.md` (+ `buttons.md`) | keep [`docs/home-contract.md`](docs/home-contract.md) in sync |
| Example dashboard | `examples/` | — |

The Python half only reads and validates Home files. It never writes them.
Bots publish by writing `home/schema.json` and `home/data.json` in their own
profile.

## Guardrails

These are the design, not leftover constraints:

- The bot owns **data**. This plugin owns **structure**.
- Widget types are a closed set. A new type is a real contribution (schema,
  renderer, skill, contract, tests). Shipping HTML or JavaScript through a
  Home is not. The user learns one set of moves per bot; that is why the
  vocabulary stays small — a purpose-built bot has a fixed job, not a new
  UI every morning.
- Buttons are the named verbs (`run_routine`, `open_chat`, `open_path`,
  `open_url`, `send_prompt`). A declared `prompt` is allowed; a shell
  command, HTML, or a prompt inside `data.json` is not. The top strip is
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
