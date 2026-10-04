import type { EngineInterface, Register } from 'claude-code'

const SYSTEM_SOUNDS = '/System/Library/Sounds'
const TONES = '/System/Library/PrivateFrameworks/ToneLibrary.framework/Versions/A/Resources/AlertTones'
const UI_SOUNDS = '/System/Library/Components/CoreAudio.component/Contents/SharedSupport/SystemSounds/system'

// iMessage's tones first (received, sent, question), then macOS's own alert sounds.
const SOUNDS: Record<string, string> = {
  message: `${TONES}/ReceivedMessage.caf`,
  sent: `${UI_SOUNDS}/SentMessage.caf`,
  question: `${TONES}/Text-Message-Acknowledgement-QuestionMark.caf`,
  ...Object.fromEntries(
    ['Basso', 'Blow', 'Bottle', 'Frog', 'Funk', 'Glass', 'Hero', 'Morse', 'Ping', 'Pop', 'Purr', 'Sosumi', 'Submarine', 'Tink'].map(name => [
      name.toLowerCase(),
      `${SYSTEM_SOUNDS}/${name}.aiff`,
    ]),
  ),
}

// `auto` shows a macOS banner from the terminal only: the desktop app has notifications of its own.
type Banner = 'auto' | 'on' | 'off'
type Settings = {
  isOn: boolean
  afterSeconds: number
  sound: string
  questionSound: string
  sentSound: string
  banner: Banner
  isQuestionOn: boolean
  isSentOn: boolean
}

const DEFAULTS: Settings = {
  isOn: true,
  afterSeconds: 0,
  sound: 'message',
  questionSound: 'question',
  sentSound: 'sent',
  banner: 'auto',
  isQuestionOn: true,
  isSentOn: true,
}

// Prompts the person sent; notifications and other agents' messages make no sound.
const OWN_PROMPTS = new Set(['composer', 'bridge', 'sdk'])

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

const saveSettings = ($: EngineInterface, settings: Settings) => $.store.set('settings', settings)

const duration = (ms: number) => {
  const seconds = Math.round(ms / 1000)

  if (seconds < 60) {
    return `${seconds}s`
  }

  const minutes = Math.floor(seconds / 60)

  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

// The reply's first line of prose: headings only when there's nothing else.
const firstLine = (text: string, max = 120) => {
  const lines = text.split('\n').filter(one => one.trim() !== '')
  const prose = lines.find(one => !/^\s*#/.test(one)) ?? lines[0] ?? ''
  const line = prose.replace(/[#*_`>]/g, '').trim()

  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

const play = async ($: EngineInterface, sound: string) => {
  const path = SOUNDS[sound] ?? `${SYSTEM_SOUNDS}/Glass.aiff`

  try {
    await $.process.run(['/usr/bin/afplay', path], { timeoutMs: 15_000 })
  } catch {
    // Not a Mac, or the sound is missing: stay quiet.
  }
}

// The app in front, as the Dock names it.
const frontApp = async ($: EngineInterface) => {
  try {
    const { stdout } = await $.process.run(['/bin/sh', '-c', 'lsappinfo info -only name "$(lsappinfo front)"'], { timeoutMs: 5_000 })

    return /"LSDisplayName"="(.*)"/.exec(stdout)?.[1]
  } catch {
    return undefined
  }
}

const shouldShowBanner = async ($: EngineInterface, banner: Banner) => {
  if (banner === 'off') {
    return false
  }

  const surface = await $.session.surface()

  if (banner === 'auto' && surface !== 'terminal') {
    return false
  }

  const front = await frontApp($)
  const host = surface === 'terminal' ? TERMINAL_APPS[(await $.env.get('TERM_PROGRAM')) ?? ''] : 'Claude'

  // Only when you're looking somewhere else.
  return front === undefined || host === undefined || front !== host
}

// Arguments go in as argv, so nothing in them is read as AppleScript.
const showBanner = async ($: EngineInterface, title: string, body: string) => {
  try {
    await $.process.run(
      ['/usr/bin/osascript', '-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title, body],
      { timeoutMs: 10_000 },
    )
  } catch {
    // No osascript, or notifications are off for it.
  }
}

const announce = async ($: EngineInterface, sound: string, title: string, body: string, banner: Banner) => {
  await Promise.all([play($, sound), (await shouldShowBanner($, banner)) ? showBanner($, title, body) : Promise.resolve()])
}

const HELP = [
  '`/chime on` · `/chime off` · `/chime test`',
  '`/chime after 60`: only chime for replies that took at least 60 seconds (`/chime after 0`: every reply)',
  '`/chime sound glass`: change the sound for replies',
  '`/chime sent off`: no swoosh when your message is sent (`/chime sent-sound pop` changes it)',
  '`/chime questions off`: no chime when Claude asks you something',
  '`/chime banner on|off|auto`: macOS notification banner too (auto: from the terminal only)',
].join('\n')

const describe = (settings: Settings) =>
  [
    !settings.isOn
      ? 'Chime is **off**.'
      : settings.afterSeconds === 0
        ? 'Chime is **on** for every reply.'
        : `Chime is **on** for replies that take ${settings.afterSeconds}s or longer.`,
    `Replies: ${settings.sound} · your messages: ${settings.isSentOn ? settings.sentSound : 'off'} · questions: ${settings.isQuestionOn ? settings.questionSound : 'off'} · banner: ${settings.banner}`,
    '',
    HELP,
  ].join('\n')

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'chime',
      description: 'Sounds when your message is sent, when Claude replies, and when Claude asks you something',
      argumentHint: '[on|off|test|after <seconds>|sound <name>]',
      immediate: true,
    })

    return started
  })

  on('command.run', { command: 'chime' }, async ($, e) => {
    const [word = '', value = ''] = e.args.trim().toLowerCase().split(/\s+/)
    const settings = await loadSettings($)

    if (word === '') {
      return { text: describe(settings) }
    }

    if (word === 'on' || word === 'off') {
      await saveSettings($, { ...settings, isOn: word === 'on' })

      return { text: word === 'on' ? 'Chime on.' : 'Chime off. `/chime on` turns it back on.' }
    }

    if (word === 'test') {
      await announce($, settings.sound, 'Claude finished', 'This is what the chime sounds like.', settings.banner === 'off' ? 'off' : 'on')

      return { text: `Played "${settings.sound}".` }
    }

    if (word === 'after') {
      const seconds = Number(value)

      if (!Number.isFinite(seconds) || seconds < 0) {
        return { text: 'Give a number of seconds: `/chime after 60`' }
      }

      await saveSettings($, { ...settings, afterSeconds: Math.round(seconds) })

      return { text: Math.round(seconds) === 0 ? 'Chiming after every reply.' : `Chiming for replies that take ${Math.round(seconds)}s or longer.` }
    }

    if (word === 'sound' || word === 'question-sound' || word === 'sent-sound') {
      if (!(value in SOUNDS)) {
        return { text: `Pick one of: ${Object.keys(SOUNDS).join(', ')}` }
      }

      const key = word === 'sound' ? 'sound' : word === 'sent-sound' ? 'sentSound' : 'questionSound'
      await saveSettings($, { ...settings, [key]: value })
      await play($, value)

      return { text: `${word === 'sound' ? 'Reply sound' : word === 'sent-sound' ? 'Sent sound' : 'Question sound'} set to "${value}".` }
    }

    if (word === 'sent' && (value === 'on' || value === 'off')) {
      await saveSettings($, { ...settings, isSentOn: value === 'on' })

      return { text: `Sent swoosh ${value}.` }
    }

    if (word === 'questions' && (value === 'on' || value === 'off')) {
      await saveSettings($, { ...settings, isQuestionOn: value === 'on' })

      return { text: `Question chime ${value}.` }
    }

    if (word === 'banner' && (value === 'on' || value === 'off' || value === 'auto')) {
      await saveSettings($, { ...settings, banner: value })

      return { text: `Banner: ${value}.` }
    }

    return { text: HELP }
  })

  // iMessage's swoosh once your message has reached Claude.
  on('prompt.submit', async ($, e, next) => {
    const entered = await next(e)

    if (OWN_PROMPTS.has(e.origin.kind) && 'text' in entered) {
      void (async () => {
        const settings = await loadSettings($)

        if (settings.isOn && settings.isSentOn) {
          await play($, settings.sentSound)
        }
      })().catch(() => {})
    }

    return entered
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)

    if (e.agentId === undefined && !e.isAborted) {
      void (async () => {
        const settings = await loadSettings($)

        if (!settings.isOn || e.durationMs < settings.afterSeconds * 1000) {
          return
        }

        const title = e.reason === 'answer' ? `Claude finished in ${duration(e.durationMs)}` : 'Claude stopped'
        await announce($, settings.sound, title, firstLine(e.answer) || 'Your reply is ready.', settings.banner)
      })().catch(() => {})
    }

    return done
  })

  // The dialog opens while the call runs, so the chime plays as it appears.
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    void (async () => {
      const settings = await loadSettings($)

      if (settings.isOn && settings.isQuestionOn) {
        const question = (e.questions as ReadonlyArray<{ question?: string }>)[0]?.question ?? 'Claude has a question for you.'
        await announce($, settings.questionSound, 'Claude has a question', firstLine(question), settings.banner)
      }
    })().catch(() => {})

    return next(e)
  })

  // Permission prompts, where the engine raises them.
  on('classic.Notification', async ($, e, next) => {
    const done = await next(e)

    if (e.notification_type === 'permission_prompt') {
      void (async () => {
        const settings = await loadSettings($)

        if (settings.isOn && settings.isQuestionOn) {
          await announce($, settings.questionSound, 'Claude needs your OK', firstLine(e.message), settings.banner)
        }
      })().catch(() => {})
    }

    return done
  })
}
