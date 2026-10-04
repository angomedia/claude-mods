import type { EngineInterface, Register } from 'claude-code'

type Settings = { isOn: boolean; everyMinutes: number; awayMinutes: number; isSoundOn: boolean }
// One timer for every session on this computer, kept in the store: `workStart` is when this
// stretch of work began, `lastActive` your last message or Claude's last reply.
type Timer = { workStart: number; lastActive: number; remindedAt: number; snoozeUntil: number }

const DEFAULTS: Settings = { isOn: true, everyMinutes: 50, awayMinutes: 10, isSoundOn: true }
const TICK_MS = 30_000
// Still working after a reminder: ask again this often.
const REPEAT_MS = 15 * 60_000
const MINUTE = 60_000
const SOUND = '/System/Library/Sounds/Glass.aiff'

// What the terminal app is called in the Dock, by $TERM_PROGRAM.
const TERMINAL_APPS: Record<string, string> = {
  Apple_Terminal: 'Terminal',
  'iTerm.app': 'iTerm2',
  vscode: 'Code',
  ghostty: 'Ghostty',
  WarpTerminal: 'Warp',
  WezTerm: 'WezTerm',
}

const loadSettings = async ($: EngineInterface): Promise<Settings> => {
  const saved = await $.store.get('settings')

  return { ...DEFAULTS, ...(typeof saved === 'object' && saved !== null ? (saved as Partial<Settings>) : {}) }
}

const loadTimer = async ($: EngineInterface, now: number): Promise<Timer> => {
  const saved = await $.store.get('timer')

  return typeof saved === 'object' && saved !== null ? (saved as Timer) : { workStart: now, lastActive: now, remindedAt: 0, snoozeUntil: 0 }
}

const saveTimer = ($: EngineInterface, timer: Timer) => $.store.set('timer', timer)

const minutes = (ms: number) => {
  const total = Math.floor(ms / MINUTE)

  if (total < 1) {
    return '<1m'
  }

  return total < 60 ? `${total}m` : `${Math.floor(total / 60)}h ${total % 60}m`
}

// Where this stretch of work began: enough time away starts a fresh one.
const stretch = (timer: Timer, settings: Settings, now: number) => {
  const isAway = now - timer.lastActive >= settings.awayMinutes * MINUTE
  const start = isAway ? now : timer.workStart

  return { isAway, elapsed: now - start, remaining: settings.everyMinutes * MINUTE - (now - start) }
}

let lastStatus: string | undefined

const showStatus = ($: EngineInterface, text: string | undefined) => {
  if (text !== lastStatus) {
    lastStatus = text
    $.ui.status(text)
  }
}

const frontApp = async ($: EngineInterface) => {
  try {
    const { stdout } = await $.process.run(['/bin/sh', '-c', 'lsappinfo info -only name "$(lsappinfo front)"'], { timeoutMs: 5_000 })

    return /"LSDisplayName"="(.*)"/.exec(stdout)?.[1]
  } catch {
    return undefined
  }
}

// A banner only when you're in another app; the toast covers the app itself.
const isLookingElsewhere = async ($: EngineInterface) => {
  const surface = await $.session.surface()
  const host = surface === 'terminal' ? TERMINAL_APPS[(await $.env.get('TERM_PROGRAM')) ?? ''] : 'Claude'
  const front = await frontApp($)

  return front === undefined || host === undefined || front !== host
}

const remind = async ($: EngineInterface, settings: Settings, elapsed: number) => {
  const body = `You've been at it for ${minutes(elapsed)}. Stand up, stretch, rest your eyes.`

  $.ui.toast(`☕ Time for a break. ${body} ${settings.awayMinutes} minutes away restarts the timer, or run /break done.`, { timeoutMs: 20_000 })

  const work: Promise<unknown>[] = []

  if (settings.isSoundOn) {
    work.push($.process.run(['/usr/bin/afplay', SOUND], { timeoutMs: 15_000 }))
  }

  if (await isLookingElsewhere($)) {
    work.push(
      $.process.run(
        ['/usr/bin/osascript', '-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', 'Time for a break ☕', body],
        { timeoutMs: 10_000 },
      ),
    )
  }

  await Promise.allSettled(work)
}

const tick = async ($: EngineInterface) => {
  const settings = await loadSettings($)

  if (!settings.isOn) {
    showStatus($, undefined)

    return
  }

  const now = await $.clock.now()
  const timer = await loadTimer($, now)
  const { isAway, elapsed, remaining } = stretch(timer, settings, now)

  if (remaining > 0) {
    showStatus($, `☕ Break in ${minutes(remaining)}`)

    return
  }

  showStatus($, `☕ Time for a break · ${minutes(elapsed)} of work`)

  if (!isAway && now >= timer.snoozeUntil && now - timer.remindedAt >= REPEAT_MS) {
    await saveTimer($, { ...timer, remindedAt: now })
    await remind($, settings, elapsed)
  }
}

// Your message or Claude's reply: you're here. Back after time away, the stretch starts over.
const markActive = async ($: EngineInterface) => {
  const [settings, now] = await Promise.all([loadSettings($), $.clock.now()])
  const timer = await loadTimer($, now)
  const isBack = now - timer.lastActive >= settings.awayMinutes * MINUTE
  await saveTimer($, isBack ? { workStart: now, lastActive: now, remindedAt: 0, snoozeUntil: 0 } : { ...timer, lastActive: now })
  await tick($)
}

const HELP = [
  '`/break done`: you just had one, restart the timer',
  '`/break snooze 10`: no reminders for 10 minutes',
  '`/break every 25`: break every 25 minutes (Pomodoro)',
  "`/break away 5`: how long away counts as a break (you don't need to tell it)",
  '`/break sound off` · `/break off` · `/break on`',
].join('\n')

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'break',
      description: 'Break reminder: see the timer, restart it, snooze, or change how often',
      argumentHint: '[done|snooze <min>|every <min>|off|on]',
      immediate: true,
    })
    lastStatus = undefined
    await markActive($)
    $.clock.every(TICK_MS, () => void tick($).catch(() => {}))

    return started
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'composer' || e.origin.kind === 'bridge' || e.origin.kind === 'sdk') {
      void markActive($).catch(() => {})
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)

    if (e.agentId === undefined) {
      void markActive($).catch(() => {})
    }

    return done
  })

  on('command.run', { command: 'break' }, async ($, e) => {
    const [word = '', value = ''] = e.args.trim().toLowerCase().split(/\s+/)
    const [settings, now] = await Promise.all([loadSettings($), $.clock.now()])
    const timer = await loadTimer($, now)
    const save = async (changed: Settings) => {
      await $.store.set('settings', changed)
      await tick($)
    }

    if (word === '') {
      if (!settings.isOn) {
        return { text: `Break reminders are off. \`/break on\` turns them back on.\n\n${HELP}` }
      }

      const { elapsed, remaining } = stretch(timer, settings, now)
      const state = remaining > 0 ? `Working for ${minutes(elapsed)}. Next break in ${minutes(remaining)}.` : `Working for ${minutes(elapsed)}. Time for a break!`

      return {
        text: [
          state,
          `Breaks every ${settings.everyMinutes} minutes; ${settings.awayMinutes} minutes away counts as one. Sound ${settings.isSoundOn ? 'on' : 'off'}.`,
          '',
          HELP,
        ].join('\n'),
      }
    }

    if (['done', 'now', 'reset', 'back'].includes(word)) {
      await saveTimer($, { workStart: now, lastActive: now, remindedAt: 0, snoozeUntil: 0 })
      await tick($)

      return { text: `Welcome back. Next break in ${settings.everyMinutes} minutes.` }
    }

    if (word === 'snooze') {
      const wait = value === '' ? 10 : Number(value)

      if (!Number.isFinite(wait) || wait <= 0) {
        return { text: 'Give a number of minutes: `/break snooze 10`' }
      }

      await saveTimer($, { ...timer, snoozeUntil: now + wait * MINUTE })

      return { text: `Snoozed. No reminders for ${Math.round(wait)} minutes.` }
    }

    if (word === 'every' || word === 'away') {
      const amount = Number(value)

      if (!Number.isFinite(amount) || amount < 1 || amount > 480) {
        return { text: `Give a number of minutes: \`/break ${word} ${word === 'every' ? 25 : 5}\`` }
      }

      await save(word === 'every' ? { ...settings, everyMinutes: Math.round(amount) } : { ...settings, awayMinutes: Math.round(amount) })

      return {
        text: word === 'every' ? `Breaks every ${Math.round(amount)} minutes.` : `${Math.round(amount)} minutes away now counts as a break.`,
      }
    }

    if (word === 'sound' && (value === 'on' || value === 'off')) {
      await save({ ...settings, isSoundOn: value === 'on' })

      return { text: `Reminder sound ${value}.` }
    }

    if (word === 'on' || word === 'off') {
      await save({ ...settings, isOn: word === 'on' })

      return { text: word === 'on' ? 'Break reminders on.' : 'Break reminders off. `/break on` turns them back on.' }
    }

    return { text: HELP }
  })
}
