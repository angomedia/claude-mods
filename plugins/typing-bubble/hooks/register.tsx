import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Mode } from '../types'

const mode = atom({ plugin: 'typing-bubble', key: 'mode' } as const, 'light')
const isOn = atom({ plugin: 'typing-bubble', key: 'isOn' } as const, true)
const frame = atom({ plugin: 'typing-bubble', key: 'frame' } as const, 0)

// iMessage's incoming bubble and its dots, as imessage-chat draws Claude's replies.
const PALETTE = {
  light: { bubble: '#E9E9EB', dot: '#8E8E93', lit: '#3C3C43' },
  dark: { bubble: '#3A3A3C', dot: '#8E8E93', lit: '#E5E5EA' },
} as const

// The desktop app's own appearance setting, falling back to macOS's when it follows the system.
const DETECT_MODE = [
  'm=$(grep -o "\\"userThemeMode\\": *\\"[a-z]*\\"" "$HOME/Library/Application Support/Claude/config.json" 2>/dev/null | sed -E "s/.*\\"([a-z]*)\\"$/\\1/")',
  'if [ "$m" = dark ] || [ "$m" = light ]; then echo "$m"',
  'elif defaults read -g AppleInterfaceStyle >/dev/null 2>&1; then echo dark',
  'else echo light; fi',
].join('\n')

// One pulse runs left to right across the dots, then rests, as iMessage's does.
const PULSE_SECONDS = 1.4
const DOT_DELAY = 0.2
const FRAME_MS = 350
// The bubble's size in CSS pixels: as tall as a one-line message bubble, plus its trailing circles.
const WIDTH = 70
const HEIGHT = 46

const bubbleSvg = (palette: (typeof PALETTE)[Mode]) => {
  const dot = (cx: number, i: number) =>
    [
      `<circle cx="${cx}" cy="20" r="4.2" fill="${palette.dot}" opacity="0.35">`,
      `<animate attributeName="opacity" values="0.35;1;0.35;0.35" keyTimes="0;0.2;0.45;1" dur="${PULSE_SECONDS}s" begin="${(i * DOT_DELAY).toFixed(2)}s" repeatCount="indefinite"/>`,
      `<animate attributeName="r" values="4.2;4.8;4.2;4.2" keyTimes="0;0.2;0.45;1" dur="${PULSE_SECONDS}s" begin="${(i * DOT_DELAY).toFixed(2)}s" repeatCount="indefinite"/>`,
      '</circle>',
    ].join('')

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 70 46">`,
    `<g fill="${palette.bubble}">`,
    // The bubble, then the two little circles that trail off its bottom-left corner.
    '<rect x="10" y="2" width="58" height="36" rx="18"/>',
    '<circle cx="12" cy="34" r="6"/>',
    '<circle cx="4" cy="42" r="3"/>',
    '</g>',
    dot(27, 0),
    dot(39, 1),
    dot(51, 2),
    '</svg>',
  ].join('')
}

// What the turn is doing, in a few words; nothing while it's just "working".
const caption = (word: string, message: string | null) => {
  const text = (message ?? word).trim().replace(/…$/, '')

  return /^(working|thinking)$/i.test(text) ? '' : text
}

const refreshMode = async ($: EngineInterface) => {
  let next: Mode = 'light'

  try {
    const { stdout } = await $.process.run(['/bin/sh', '-c', DETECT_MODE], { timeoutMs: 5000 })
    next = stdout.trim() === 'dark' ? 'dark' : 'light'
  } catch {
    const theme = (await $.config.list()).find(row => row.key === 'theme')
    next = String(theme?.value ?? '').includes('light') ? 'light' : 'dark'
  }

  if ((await read($, mode)) !== next) {
    await update($, mode, () => next)
  }
}

let ticker: Timer | undefined

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'typing',
      description: "Turn iMessage's typing bubble on or off",
      argumentHint: '[on|off]',
      immediate: true,
    })
    const saved = await $.store.get('isOn')
    await update($, isOn, () => saved !== false)
    await refreshMode($)

    return started
  })

  on('command.run', { command: 'typing' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const shown = arg === 'on' ? true : arg === 'off' ? false : !(await read($, isOn))
    await update($, isOn, () => shown)
    await $.store.set('isOn', shown)

    return { text: shown ? 'Typing bubble on.' : 'Typing bubble off. Run /typing to turn it back on.' }
  })

  on('turn.start', async ($, e, next) => {
    const started = await next(e)
    void refreshMode($).catch(() => {})

    // The terminal can't animate an SVG, so its dots step on a timer while the turn runs.
    if ((await $.session.surfaces()).includes('terminal')) {
      ticker?.cancel()
      ticker = $.clock.every(FRAME_MS, () => void update($, frame, n => (n + 1) % 4).catch(() => {}))
    }

    return started
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)

    if (e.agentId === undefined) {
      ticker?.cancel()
      ticker = undefined
    }

    return done
  })

  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    if (!(await read($, isOn))) {
      return next(e)
    }

    const palette = PALETTE[await read($, mode)]
    const label = caption(e.props.word, e.props.message)

    if (e.surface === 'terminal') {
      const { Box, Text } = $.ui.resolve(e)
      const lit = (await read($, frame)) % 4

      return (
        <Box flexDirection="row" gap={1}>
          <Text backgroundColor={palette.bubble}>
            {' '}
            {[0, 1, 2].map(i => (
              <Text key={`dot-${i}`} color={i === lit ? palette.lit : palette.dot}>
                {i === 2 ? '●' : '● '}
              </Text>
            ))}{' '}
          </Text>
          {label === '' ? null : <Text dimColor>{label}</Text>}
        </Box>
      )
    }

    if (e.surface !== 'desktop') {
      return next(e)
    }

    const { Box, Svg, Text } = $.ui.resolve(e)

    // Full width and left-aligned, so the bubble sits where Claude's replies start. The size is given
    // outright: an interactive Svg draws in a frame, which the row would otherwise shrink to fit.
    return (
      <Box width="100%" flexDirection="row" justifyContent="flex-start" alignItems="center" gap={1}>
        <Svg
          source={bubbleSvg(palette)}
          alt={label === '' ? 'Claude is typing' : `Claude is typing: ${label}`}
          width={WIDTH}
          height={HEIGHT}
          isInteractive
        />
        {label === '' ? null : <Text color="subtle">{label}</Text>}
      </Box>
    )
  })
}
