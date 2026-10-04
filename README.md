# claude-mods

Mods for [Claude Code](https://claude.com/claude-code): plugins that change how Claude Code looks and behaves.

## Install

| Mod | What it does |
| --- | --- |
| [imessage-chat](#imessage-chat) | Draws the chat as iMessage bubbles |
| [session-hud](#session-hud) | A card above the message box with context, usage limits and cost |
| [typing-bubble](#typing-bubble) | iMessage's typing bubble while Claude works |
| [done-chime](#done-chime) | A sound when a long reply is done or Claude asks you something |
| [turn-summary](#turn-summary) | How long each reply took, tools used, files and lines changed |
| [text-expander](#text-expander) | Type `;;t` and send a whole prompt |
| [files-changed](#files-changed) | A pane listing every file Claude changed this session |
| [break-reminder](#break-reminder) | A countdown to your next break, and a nudge when it's time |
| [project-notes](#project-notes) | A checklist pane for each project, kept between sessions |

Add this repo as a plugin marketplace, then install the mods you want:

```bash
claude plugin marketplace add https://github.com/angomedia/claude-mods.git
```

```bash
claude plugin install typing-bubble@claude-mods
```

Or install them all at once:

```bash
for mod in imessage-chat session-hud typing-bubble done-chime turn-summary text-expander files-changed break-reminder project-notes; do claude plugin install "$mod@claude-mods"; done
```

Start a new Claude Code session to load them. Mods need a recent Claude Code (2.1.286 or later is tested). The sounds, banners and "open file" buttons use macOS tools; on other systems those parts stay quiet and the rest works.

To update later:

```bash
claude plugin marketplace update claude-mods
```

```bash
for mod in imessage-chat session-hud typing-bubble done-chime turn-summary text-expander files-changed break-reminder project-notes; do claude plugin update "$mod@claude-mods"; done
```

To share them, send someone the repo link and the install lines above. A private repo needs them to have access to it.

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

A small card above the message box, in even columns, each with a label, a reading and one line of detail:

- **Context**: how full the context window is, with a meter, and tokens used out of the window.
- **5-hour limit** and **Weekly limit**: how much of each is used, and when it resets (a countdown within a day, a day and time beyond that).
- **Session**: how long it has run, and what it would have cost at API prices (*API ≈ $…*; plans like Max don't charge this).
- **Model and effort**, in the terminal only: the desktop app already shows them under the message box.

Meters turn orange at 70% and red at 90%. The figures refresh every 5 seconds and after every reply.

Two buttons on the right:

- **Compact** runs `/compact`. It's highlighted once context passes 70%.
- **Fresh start** asks for a second press, then has Claude write a handoff note (goal, current state, decisions, files, next steps, open questions), runs `/clear`, and gives the note to the fresh conversation. The note shows in the chat, and on a Mac it's also copied to the clipboard. Use it when a long session starts to drift.

Both wait until Claude has finished replying. `/hud off` hides the card, `/hud on` shows it, `/hud` toggles; the choice is remembered. Apart from `pbcopy` for the clipboard copy, it runs nothing on your computer.

### typing-bubble

While Claude works, the spinner becomes iMessage's typing bubble: a gray bubble with three dots that pulse left to right. When Claude is running a step, what it's doing shows beside the bubble (*Creating notes.md*).

- Colors follow light and dark mode the same way imessage-chat does. In the terminal, the dots step along in a small gray chip.
- While it's on, the spinner's elapsed time and token count don't show.
- `/typing off` brings the normal spinner back, `/typing on` the bubble; the choice is remembered.

**What it runs on your computer:** the same light/dark check as imessage-chat (it reads `userThemeMode` from the Claude app's `config.json`, then `defaults read -g AppleInterfaceStyle`), once per reply.

### done-chime

Plays iMessage's "new message" sound when a reply took 30 seconds or more, so you can look away while Claude works. When Claude asks you something (a question dialog, or a permission prompt where the app reports one), it plays the question tone instead.

- From the terminal it also shows a macOS notification banner when you're in another app. The desktop app has notifications of its own, so there it only plays the sound unless you turn banners on.
- `/chime` shows the settings. `/chime test` plays it. `/chime after 60` chimes only for replies of a minute or more. `/chime sound glass` changes the sound: `message`, `question`, or one of macOS's `basso`, `blow`, `bottle`, `frog`, `funk`, `glass`, `hero`, `morse`, `ping`, `pop`, `purr`, `sosumi`, `submarine`, `tink`. `/chime questions off` stops the question tone. `/chime banner on|off|auto` sets the banner. `/chime off` turns it all off.

**What it runs on your computer:** `afplay` to play the sound, `lsappinfo` to see which app is in front, and `osascript` to show the banner.

### turn-summary

Sums up each reply: how long it took, how many tools Claude used, and which files changed by how many lines.

> Last reply · 2m 14s · 9 tools · register.tsx, README.md +42 −10

- **Desktop app:** the line sits under the message box, and counts up live while Claude works.
- **Terminal:** it's added to the "Baked for 3s" line under each reply.
- Lines are counted from Claude's own file edits. Files changed by shell commands aren't counted.
- `/summary off` and `/summary on`. It runs nothing on your computer.

### text-expander

Type a short trigger like `;;t` anywhere in a message, and when you send it, it's swapped for the full text. A small pop-up says what was expanded, and your message shows the full text.

It starts with six snippets:

| Type | To send |
| --- | --- |
| `;;t` | Run the tests and fix anything that fails. Tell me what you changed. |
| `;;e` | Explain this in plain language, as if I'm new to it. Keep it short. |
| `;;r` | Review what you just changed for bugs and edge cases before we move on. |
| `;;s` | Summarize what you did, what you checked, and what's left, in a few bullets. |
| `;;p` | Make a plan first and wait for my OK before changing any files. |
| `;;c` | Commit these changes with a clear message. |

**Keeping track of them.** `/snippets` lists every snippet you have and the file it's saved in.

**Adding, changing and removing them:**

- `/snippets add ;;bug Find the root cause before fixing anything.` adds one for every project. Adding a trigger that exists replaces its text.
- `/snippets add-here ;;deploy Run ./deploy.sh staging and show me the output.` adds one for this project only.
- `/snippets remove ;;bug` removes one.
- `/snippets edit` opens your snippets file in your text editor; `/snippets edit here` opens this project's.

**Where they're saved.** Snippets are plain JSON, one `"trigger": "text"` pair each:

- `~/.claude/snippets.json`: yours, in every project.
- `.claude/snippets.json` in a project's folder: that project's. Commit it and everyone on the project gets them. A project snippet wins over one of yours with the same trigger.

```json
{
  ";;t": "Run the tests and fix anything that fails.",
  ";;deploy": "Run ./deploy.sh staging and show me the output."
}
```

Changes work on your next message; nothing needs restarting. To take your snippets to another computer, copy `~/.claude/snippets.json` there (or keep it with your dotfiles).

A trigger is any word with no spaces, and only expands as a whole word, so `;;t` inside `a;;t` stays as typed. Starting triggers with `;;` keeps them from clashing with real words. If you delete the snippets file, it isn't recreated.

**What it runs on your computer:** `open -t` for `/snippets edit`.

### files-changed

`/files` opens a pane listing every file Claude edited or created this session, newest first: its name and folder, lines added and removed, and how many edits (or *new*).

- Click a file to open it: in VS Code if it's installed, otherwise in your default text editor.
- **Copy paths** puts every path on the clipboard; **Clear** empties the list (`/files clear` too).
- The first time Claude changes a file in a session, a pop-up points you to `/files`.
- `/files` again closes the pane.
- It lists files changed through Claude's edit tools; files changed by shell commands aren't listed.

**What it runs on your computer:** `open` to open a file and `pbcopy` for Copy paths.

### break-reminder

A countdown under the message box: *☕ Break in 18m*. After 50 minutes of work you get a reminder pop-up and a soft sound, plus a macOS banner if you're in another app. If you keep working, it asks again every 15 minutes.

- **Time away counts as a break.** Ten minutes without sending a message starts the next stretch fresh, so you don't have to tell it you took one.
- One timer covers every Claude Code session on your computer, so several open sessions don't each nag you.
- `/break` shows how long you've been working. `/break done` restarts the timer. `/break snooze 10` holds reminders for 10 minutes. `/break every 25` sets the interval (25 is a Pomodoro). `/break away 5` sets how long away counts as a break. `/break sound off`, `/break off`, `/break on`.

**What it runs on your computer:** `afplay` for the sound, `lsappinfo` to see which app is in front, and `osascript` for the banner.

### project-notes

`/notes` opens a checklist pane for the project you're in. Type in the box at the top to add a note, click ☐ to tick one off, ✕ to delete it. **Clear done** removes the ticked ones; **Open file** opens the notes in your text editor. `/notes` again closes the pane.

- `/note check the logo on dark mode` adds a note without opening the pane.
- Each project has its own notes, kept between sessions as a plain Markdown checklist in `~/.claude/notes/` (named after the project's folder). Edit the file anywhere; the pane picks up changes within a few seconds. Headings and other lines you write there show in the pane too.
- Claude doesn't see your notes unless you share them.

**What it runs on your computer:** `open -t` for Open file.

## Adding a mod

Each mod is a folder under `plugins/` with a `.claude-plugin/plugin.json`, listed in [`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json). Bump a mod's `version` in its `plugin.json` when you change it so `claude plugin update` picks up the change.

## License

MIT
