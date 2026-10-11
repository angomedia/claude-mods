import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

const pending = atom({ plugin: 'screenshot-attach', key: 'pending' } as const, 0)

const MAX = 10
// macOS shows a new screenshot as a thumbnail in the corner for about five seconds before it
// saves the file. A message sent in that time waits for it, this long at most.
const SAVE_WAIT_MS = 7_000
const POLL_MS = 400
// A screenshot older than this is almost never the one the person means (their new one went to the
// clipboard, or wasn't taken): it's left out, and they're told, rather than sent without a word.
const STALE_MS = 24 * 60 * 60_000
// ;;ss, or ;;ss3 for the last three, as a word of its own anywhere in the message.
const TOKEN = /(^|\s);;ss(\d{1,2})?(?=$|\s|[.,!?:)\]])/gi
// What macOS and the common screenshot apps name their files, in a few languages.
const SCREENSHOT_NAME = /^(screenshot|screen shot|cleanshot|bildschirmfoto|capture d.écran|captura de pantalla|schermafbeelding|istantanea|スクリーンショット)/i
const IMAGE = /\.(png|jpe?g|heic|tiff?|webp)$/i

// Prompts the person sent; notifications and other agents' messages are left as they are.
const OWN_PROMPTS = new Set(['composer', 'bridge', 'sdk'])

type Shot = { path: string; name: string; at: number }

const clamp = (count: number) => Math.max(1, Math.min(MAX, Math.round(count)))

// Where screenshots are saved: macOS's own setting when it has one, the Desktop when not.
const screenshotFolder = async ($: EngineInterface) => {
  const home = (await $.env.get('HOME')) ?? ''

  try {
    const { exitCode, stdout } = await $.process.run(['/usr/bin/defaults', 'read', 'com.apple.screencapture', 'location'], { timeoutMs: 5_000 })
    const folder = stdout.trim().replace(/^~(?=\/|$)/, home).replace(/\/$/, '')

    if (exitCode === 0 && folder !== '' && (await $.fs.exists(folder))) {
      return { folder, home }
    }
  } catch {
    // No `defaults` (not a Mac): the Desktop it is.
  }

  return { folder: `${home}/Desktop`, home }
}

const tidy = (path: string, home: string) => (home !== '' && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path)

const latestShots = async ($: EngineInterface, count: number) => {
  const { folder, home } = await screenshotFolder($)
  const entries = await $.fs.list(folder).catch(() => [])
  const shots: Shot[] = entries
    .filter(entry => entry.kind === 'file' && IMAGE.test(entry.name) && SCREENSHOT_NAME.test(entry.name))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, count)
    .map(entry => ({ path: `${folder}/${entry.name}`, name: entry.name, at: entry.mtimeMs }))

  return { shots, folder, home }
}

// The thumbnail is drawn by screencaptureui, which runs only around a capture.
const isCapturing = async ($: EngineInterface) => {
  try {
    return (await $.process.run(['/usr/bin/pgrep', '-x', 'screencaptureui'], { timeoutMs: 3_000 })).exitCode === 0
  } catch {
    return false
  }
}

// Waits, while a screenshot is still on its way to the folder, until it lands.
const waitForSaving = async ($: EngineInterface, signal: AbortSignal) => {
  if (!(await isCapturing($))) {
    return
  }

  $.ui.toast('Waiting a moment for your screenshot to save…')
  const { shots } = await latestShots($, 1)
  const before = shots[0]?.at ?? 0
  const deadline = (await $.clock.now()) + SAVE_WAIT_MS

  while ((await $.clock.now()) < deadline) {
    await $.clock.sleep(POLL_MS, { signal })
    const { shots: now } = await latestShots($, 1)

    if ((now[0]?.at ?? 0) > before || !(await isCapturing($))) {
      return
    }
  }
}

const ago = (ms: number) => {
  const minutes = Math.floor(Math.max(0, ms) / 60_000)

  if (minutes < 1) {
    return 'just now'
  }

  if (minutes < 60) {
    return `${minutes} min ago`
  }

  const hours = Math.floor(minutes / 60)

  if (hours < 24) {
    return `${hours} h ago`
  }

  const days = Math.floor(hours / 24)

  return days === 1 ? 'yesterday' : `${days} days ago`
}

// "Screenshot 2026-10-03 at 8.41.21 PM.png" -> "Screenshot 8.41.21 PM"
const shortName = (name: string) => name.replace(IMAGE, '').replace(/ \d{4}-\d{2}-\d{2} at/, '').replace(/\s+/g, ' ')

// What the model reads beside the message: the files, newest first, and to open them.
const contextFor = (shots: readonly Shot[], now: number) =>
  [
    `The person attached their ${shots.length === 1 ? 'latest screenshot' : `${shots.length} latest screenshots`} to this message (newest first):`,
    ...shots.map((shot, i) => `${i + 1}. ${shot.path} (taken ${ago(now - shot.at)})`),
    'Look at each one with the Read tool before you answer: they are part of what the person is showing you.',
  ].join('\n')

// The screenshots recent enough to be the ones meant.
const freshOf = (shots: readonly Shot[], now: number) => shots.filter(shot => now - shot.at <= STALE_MS)

const staleNote = (newest: Shot, now: number) => `Your newest screenshot is from ${ago(now - newest.at)} (${shortName(newest.name)})`

// What the model reads when the screenshot asked for was too old to send: why there's none, and what to ask for.
const staleContextFor = (newest: Shot, now: number) =>
  [
    `The person asked to attach their latest screenshot, but the newest one (${newest.path}) was taken ${ago(now - newest.at)}, so it was not attached.`,
    'If they meant to show you something on screen, ask them to take a new screenshot (⌘⇧4 saves it to a file) or paste the image.',
  ].join(' ')

const leftOut = (count: number) => (count === 0 ? '' : `; ${count} older than a day left out`)

const HELP = [
  '**In a message:** put `;;ss` anywhere and your latest screenshot goes with it; `;;ss3` sends the last three.',
  '**Before a message:** `/ss` attaches your latest screenshot to the next message you send, `/ss 3` the last three, `/ss off` cancels.',
].join('\n')

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'ss',
      description: 'Attach your latest screenshots to your next message (or type ;;ss in a message)',
      argumentHint: '[how many|off|help]',
      immediate: true,
    })

    return started
  })

  on('command.run', { command: 'ss' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()

    if (arg === 'off' || arg === 'cancel' || arg === '0') {
      await update($, pending, () => 0)
      $.ui.status(undefined)

      return { text: 'No screenshots will be attached.' }
    }

    if (arg === 'help' || (arg !== '' && !/^\d{1,2}$/.test(arg))) {
      const { folder, home } = await screenshotFolder($)

      return { text: `${HELP}\n\nScreenshots are read from \`${tidy(folder, home)}\`, newest first.` }
    }

    const count = clamp(arg === '' ? 1 : Number(arg))
    const [{ shots: found, folder, home }, now] = await Promise.all([latestShots($, count), $.clock.now()])
    const shots = freshOf(found, now)
    const newest = shots[0]

    if (found[0] === undefined) {
      return { text: `There are no screenshots in \`${tidy(folder, home)}\` yet. Take one with ⌘⇧4, then try again.` }
    }

    if (newest === undefined) {
      return { text: `${staleNote(found[0], now)}, so nothing was set to attach. Take a new one with ⌘⇧4, then run /ss again.` }
    }

    await update($, pending, () => shots.length)
    $.ui.status(`📎 ${shots.length === 1 ? '1 screenshot' : `${shots.length} screenshots`} will go with your next message`)

    return {
      text:
        shots.length === 1
          ? `Your next message will include ${shortName(newest.name)} (${ago(now - newest.at)})${leftOut(found.length - 1)}.`
          : `Your next message will include your last ${shots.length} screenshots (newest ${ago(now - newest.at)})${leftOut(found.length - shots.length)}.`,
    }
  })

  on('prompt.submit', async ($, e, next) => {
    if (!OWN_PROMPTS.has(e.origin.kind)) {
      return next(e)
    }

    // The most screenshots asked for, by ;;ss in the text or by /ss beforehand.
    let wanted = await read($, pending)
    const stripped = e.text.replace(TOKEN, (_match, lead: string, digits: string | undefined) => {
      wanted = Math.max(wanted, clamp(digits === undefined ? 1 : Number(digits)))

      return lead
    })

    if (wanted === 0) {
      return next(e)
    }

    await update($, pending, () => 0)
    $.ui.status(undefined)
    await waitForSaving($, next.signal).catch(() => undefined)
    const [{ shots: found, folder, home }, now] = await Promise.all([latestShots($, wanted), $.clock.now()])
    const shots = freshOf(found, now)
    const newest = shots[0]
    const text = stripped.replace(/[ \t]{2,}/g, ' ').trim()

    if (found[0] === undefined) {
      $.ui.toast(`No screenshots found in ${tidy(folder, home)}, so none were attached.`)

      return next({ ...e, text: text === '' ? e.text : text })
    }

    // Only old ones: none goes, the person sees why, and so does Claude.
    if (newest === undefined) {
      $.ui.toast(`${staleNote(found[0], now)}, so it wasn't attached. Take a new one with ⌘⇧4, or paste the image.`, { timeoutMs: 8_000 })

      return next({ ...e, text: text === '' ? e.text : text, context: [...(e.context ?? []), staleContextFor(found[0], now)] })
    }

    const skipped = leftOut(found.length - shots.length)
    $.ui.toast(
      shots.length === 1
        ? `📎 Attached ${shortName(newest.name)} (${ago(now - newest.at)})${skipped}`
        : `📎 Attached ${shots.length} screenshots (newest ${ago(now - newest.at)})${skipped}`,
    )

    return next({
      ...e,
      text: text !== '' ? text : shots.length === 1 ? "Here's my latest screenshot." : `Here are my last ${shots.length} screenshots.`,
      context: [...(e.context ?? []), contextFor(shots, now)],
    })
  })
}
