# claude-mods

Mods for [Claude Code](https://claude.com/claude-code): plugins that change how Claude Code looks and behaves.

## Install

Add this repo as a plugin marketplace, then install the mods you want:

```bash
claude plugin marketplace add https://github.com/angomedia/claude-mods.git
claude plugin install imessage-chat@claude-mods
claude plugin install session-hud@claude-mods
```

Start a new Claude Code session to load them. Mods need a recent Claude Code (2.1.286 or later is tested).

To update later:

```bash
claude plugin marketplace update claude-mods
claude plugin update imessage-chat@claude-mods
claude plugin update session-hud@claude-mods
```

## Mods

### imessage-chat

Draws the conversation as iMessage-style bubbles: your messages in blue on the right, Claude's replies in gray on the left. Tool steps, notifications and messages from other agents keep their normal look.

- **Your messages** are drawn as true iMessage bubbles: pill-shaped corners, the tail, and the macOS system font. They're pictures, so their text can't be selected. In the terminal, which can't show pictures, they're rounded boxes instead. Images you attach still show, above the bubble.
- **Claude's replies** stay real text, so formatting, code blocks, links and copying all still work. Their corners use the app's roundest box style, which is a little less round than iMessage's.
- Mods can't change the app's background or the message box you type in.
- `/imessage off` turns the bubbles off, `/imessage on` turns them back on, `/imessage` toggles. The choice is remembered.
- Light and dark colors follow the Claude desktop app's appearance setting on macOS, checked every 20 seconds. Elsewhere they follow Claude Code's own theme.
- Messages over 10,000 characters keep the normal look.

**What it runs on your computer:** to tell light from dark mode on macOS, it runs a short `/bin/sh` command that reads `userThemeMode` from the Claude app's `config.json` and, if that is set to follow the system, runs `defaults read -g AppleInterfaceStyle`. When a session starts, it also reads that session's own transcript with `python3` to find earlier messages that had images attached. It reads nothing else and sends nothing anywhere. See [`register.tsx`](plugins/imessage-chat/hooks/register.tsx).

### session-hud

A small card above the message box with what a terminal status line would show:

- **Model and effort**, as each request goes out (for example *Opus 5.5 · Extra*).
- **Context window**: how full it is, with a meter, and tokens used out of the window.
- **Usage limits**: your 5-hour and weekly windows, how much of each is used, and when each resets.
- **Session cost** (what the session would cost at API prices) and **how long the session has run**.

Meters turn orange at 70% and red at 90%. The figures refresh every 5 seconds and after every reply. `/hud off` hides the card, `/hud on` shows it, `/hud` toggles; the choice is remembered. It runs nothing on your computer and reads only Claude Code's own session figures.

## Adding a mod

Each mod is a folder under `plugins/` with a `.claude-plugin/plugin.json`, listed in [`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json). Bump a mod's `version` in its `plugin.json` when you change it so `claude plugin update` picks up the change.

## License

MIT
