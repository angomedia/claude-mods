# claude-mods

Mods for [Claude Code](https://claude.com/claude-code): plugins that change how Claude Code looks and behaves.

## Install

| Mod | What it does |
| --- | --- |
| [imessage-chat](#imessage-chat) | Draws the chat as iMessage bubbles |
| [session-hud](#session-hud) | A card above the message box with context, usage limits and cost |
| [typing-bubble](#typing-bubble) | iMessage's typing bubble while Claude works |
| [done-chime](#done-chime) | iMessage's sounds: a swoosh when you send, a tone when Claude replies |
| [turn-summary](#turn-summary) | How long each reply took, tools used, files and lines changed |
| [text-expander](#text-expander) | Type `;;t` and send a whole prompt |
| [files-changed](#files-changed) | A pane listing every file Claude changed this session |
| [break-reminder](#break-reminder) | A countdown to your next break, and a nudge when it's time |
| [project-notes](#project-notes) | A checklist pane for each project, kept between sessions |
| [screenshot-attach](#screenshot-attach) | Type `;;ss` and your latest screenshot goes with your message |

Add this repo as a plugin marketplace, then install the mods you want:

```bash
claude plugin marketplace add https://github.com/angomedia/claude-mods.git
```

```bash
claude plugin install typing-bubble@claude-mods
```

Or install them all at once:

```bash
for mod in imessage-chat session-hud typing-bubble done-chime turn-summary text-expander files-changed break-reminder project-notes screenshot-attach; do claude plugin install "$mod@claude-mods"; done
```

Start a new Claude Code session to load them. Mods need a recent Claude Code (2.1.286 or later is tested). The sounds, banners and "open file" buttons use macOS tools; on other systems those parts stay quiet and the rest works.

To update later:

```bash
claude plugin marketplace update claude-mods
```

```bash
for mod in imessage-chat session-hud typing-bubble done-chime turn-summary text-expander files-changed break-reminder project-notes screenshot-attach; do claude plugin update "$mod@claude-mods"; done
```

To share them, send someone the repo link and the install lines above. A private repo needs them to have access to it.

## Mods

### imessage-chat

Draws the conversation as iMessage-style bubbles: your messages in blue on the right, Claude's replies in a softer blue on the left. Tool steps, notifications and messages from other agents keep their normal look.

- **Your messages** are drawn as true iMessage bubbles: pill-shaped corners, the tail, and the macOS system font. They're pictures, so their text can't be selected. In the terminal, which can't show pictures, they're rounded boxes instead. Images you attach still show, above the bubble.
- **Claude's replies** stay real text, so formatting, code blocks, links and copying all still work. Their corners use the app's roundest box style, which is a little less round than iMessage's.
- **Reply color:** a soft blue in light mode and a deep blue in dark mode. A mod can't change the color of the reply text itself, so the blue is chosen to keep the app's text easy to read on it. `/imessage replies gray` switches to iMessage's gray, `/imessage replies blue` back.
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

While Claude works, you see iMessage's typing bubble: a gray bubble with three dots that pulse left to right.

- **Desktop app:** the bubble sits where iMessage puts it, at the bottom of the chat on the left, just above where you type (above session-hud's card, if you have it). While Claude runs a step, what it's doing shows beside the bubble (*Editing notes.md*, *Searching the code*). The app's own one-line spinner is hidden while the bubble is on.
- **Terminal:** the dots step along in a small gray chip, in place of the spinner.
- Colors follow light and dark mode the same way imessage-chat does.
- `/typing off` brings the normal spinner back, `/typing on` the bubble; the choice is remembered.

**What it runs on your computer:** the same light/dark check as imessage-chat (it reads `userThemeMode` from the Claude app's `config.json`, then `defaults read -g AppleInterfaceStyle`), once per reply.

### done-chime

iMessage's sounds for the conversation, so you can look away while Claude works:

- **Your message is sent:** iMessage's "sent" swoosh, once it has reached Claude.
- **Claude's reply arrives:** iMessage's "new message" tone, after every reply.
- **Claude asks you something:** the question tone, for a question dialog, or a permission prompt where the app reports one.

From the terminal it also shows a macOS notification banner when you're in another app. The desktop app has notifications of its own, so there it only plays the sounds unless you turn banners on.

- `/chime` shows the settings. `/chime test` plays the reply tone.
- `/chime sent off` stops the swoosh; `/chime sent-sound pop` changes it.
- `/chime after 60` plays the reply tone only for replies that took a minute or more (`/chime after 0` goes back to every reply). `/chime sound glass` changes the reply tone.
- Sounds to pick from: `message`, `sent`, `question`, or one of macOS's `basso`, `blow`, `bottle`, `frog`, `funk`, `glass`, `hero`, `morse`, `ping`, `pop`, `purr`, `sosumi`, `submarine`, `tink`.
- `/chime questions off` stops the question tone. `/chime banner on|off|auto` sets the banner. `/chime off` turns every sound off.

**What it runs on your computer:** `afplay` to play the sound, `lsappinfo` to see which app is in front, and `osascript` to show the banner.

### turn-summary

Sums up each reply: how long it took, how many tools Claude used, and which files changed by how many lines.

> Last reply · 2m 14s · 9 tools · register.tsx, README.md +42 −10

- **Desktop app:** the line sits under the message box, and counts up live while Claude works.
- **Terminal:** it's added to the "Baked for 3s" line under each reply.
- Lines are counted from Claude's own file edits. Files changed by shell commands aren't counted.
- `/summary off` and `/summary on`. It runs nothing on your computer.

### text-expander

Type a short trigger like `;;t` anywhere in a message, and when you send it, it's swapped for the full text. The swap happens as the message is sent, not while you type (mods can't change the message box): a small pop-up says what was expanded, and your message shows the full text.

It starts with six snippets:

| Type | To send |
| --- | --- |
| `;;t` | Run the tests and fix anything that fails. Tell me what you changed. |
| `;;e` | Explain this in plain language, as if I'm new to it. Keep it short. |
| `;;r` | Review what you just changed for bugs and edge cases before we move on. |
| `;;s` | Summarize what you did, what you checked, and what's left, in a few bullets. |
| `;;p` | Make a plan first and wait for my OK before changing any files. |
| `;;c` | Commit these changes with a clear message. |

**Managing them.** `/snippets` opens the Snippets window: a two-column table of each short form and what it turns into.

- **Add a row:** in the box at the bottom, type the short form, a space, then what it turns into (`;;hi How are you doing?`), and press Enter or **Add**. Adding a short form you already have replaces its text.
- **Delete a row:** click ✕ at the end of it.
- **Open file** opens the snippets file in your text editor; **Done** or Esc closes the window. `/snippets` again closes it too.

The same things from the message box:

- `/snippets list` prints them all, with the files they're in.
- `/snippets add ;;bug Find the root cause before fixing anything.` adds one for every project.
- `/snippets add-here ;;deploy Run ./deploy.sh staging and show me the output.` adds one for this project only.
- `/snippets remove ;;bug` removes one, and `/snippets edit` (or `/snippets edit here`) opens the file.

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

### screenshot-attach

Attach your latest screenshots to a message without dragging them in.

- **In a message:** put `;;ss` anywhere, and your newest screenshot goes with it. `;;ss3` sends your last three (up to 10). The `;;ss` itself is taken out of your message, and a pop-up says what was attached (*📎 Attached Screenshot 8.41.21 PM (4 min ago)*). Sent on its own, `;;ss` becomes "Here's my latest screenshot."
- **Before a message:** `/ss` sets your newest screenshot to go with the next message you send, `/ss 3` the last three. The line under the message box says so until you send; `/ss off` cancels.
- **Just took one?** macOS shows a new screenshot as a little preview in the corner for a few seconds before saving it. If you send `;;ss` during that time, the message waits (up to about 7 seconds) for it to save, so you get the one you just took. To skip the wait, turn off **Show Floating Thumbnail** in the Screenshot app's Options (⌘⇧5).
- **Where it looks:** the folder macOS saves screenshots to (the Desktop unless you changed it in the Screenshot app's Options), newest first, by the time each was taken. Only files named like screenshots count, so other pictures on your Desktop are left out.
- **How Claude sees them:** a mod can't put pictures into a message itself, so it tells Claude which screenshot files you attached, and Claude opens each one with its file viewer before answering. You'll see a "Read" step for each.
- `;;ss` is taken, so don't use it as a text-expander snippet.

**What it runs on your computer:** `defaults read com.apple.screencapture location` to find your screenshot folder, and `pgrep -x screencaptureui` to tell whether a screenshot is still being saved. It lists that folder's file names and dates; Claude reads only the screenshots you attach.

## Adding a mod

Each mod is a folder under `plugins/` with a `.claude-plugin/plugin.json`, listed in [`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json). Bump a mod's `version` in its `plugin.json` when you change it so `claude plugin update` picks up the change.

## License

MIT
