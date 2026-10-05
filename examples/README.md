# Example Home

A complete pair, taken from a research bot that publishes after each morning
digest. Copy both files and the `actions/` folder into a bot's profile to see
the page render, then let the bot take over `data.json`:

```bash
mkdir -p ~/.hermes/profiles/<bot>/home
cp -R schema.json data.json actions ~/.hermes/profiles/<bot>/home/
chmod +x ~/.hermes/profiles/<bot>/home/actions/*
```

`schema.json` declares a toolbar, seven widgets (including a `buttons` card
and line buttons on findings), and a composer. `data.json` fills five of the
data widgets and leaves themes empty on purpose, so you can see how an
unfilled widget renders.

The findings line buttons show both kinds of click. **Genuine** is a
`run_action`: `actions/genuine` records the verdict and marks the row good
with no chat turn. Your first click asks you to approve that script.
**Escalate** is a `send_prompt`, because the bot has to write the email to
the owning team. Full reference: `../docs/home-contract.md`.
