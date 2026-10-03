import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Mode } from '../types'

const mode = atom({ plugin: 'imessage-chat', key: 'mode' } as const, 'light')
const isOn = atom({ plugin: 'imessage-chat', key: 'isOn' } as const, true)

// iOS system colors: outgoing blue, incoming gray.
const PALETTE = {
  light: { blue: '#007AFF', gray: '#E9E9EB' },
  dark: { blue: '#0A84FF', gray: '#3A3A3C' },
} as const

// The desktop app's own appearance setting, falling back to macOS's when it follows the system.
const DETECT_MODE = [
  'm=$(grep -o "\\"userThemeMode\\": *\\"[a-z]*\\"" "$HOME/Library/Application Support/Claude/config.json" 2>/dev/null | sed -E "s/.*\\"([a-z]*)\\"$/\\1/")',
  'if [ "$m" = dark ] || [ "$m" = light ]; then echo "$m"',
  'elif defaults read -g AppleInterfaceStyle >/dev/null 2>&1; then echo dark',
  'else echo light; fi',
].join('\n')

// Prompts the person sent; notifications and other agents' messages keep their own look.
const OWN_PROMPTS = new Set(['composer', 'bridge', 'sdk', 'scheduled-trigger'])

// A tree's text is capped at 10000 characters, tab and newline its only control characters;
// longer messages keep the engine's own drawing.
const MAX_TEXT = 10_000
const clean = (text: string) => text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '')

// Box corners stop at the app's own "round" radius, so outgoing bubbles are drawn as SVG:
// iMessage's pill corners and tail, in the macOS system font (SF Pro) at 15px.
// Advance widths of ASCII 32..126 in that font, measured with AppKit.
const SF_15 = [
  3.98, 4.43, 6.93, 9.21, 9.21, 13.65, 10.44, 4.22, 5.49, 5.49, 6.84, 9.21, 4.22, 6.84, 4.22, 4.34,
  9.21, 6.72, 8.82, 9.17, 9.42, 9.04, 9.32, 8.31, 9.35, 9.32, 4.22, 4.22, 9.21, 9.21, 9.21, 7.46,
  13.54, 9.87, 9.62, 10.5, 10.66, 8.7, 8.35, 10.96, 10.9, 3.78, 7.84, 9.65, 8.28, 12.88, 10.9, 11.34,
  9.29, 11.34, 9.57, 9.32, 9.27, 10.83, 9.87, 14.28, 9.95, 9.59, 9.69, 5.49, 4.34, 5.49, 9.21, 8.52,
  7.27, 8.04, 8.98, 8.16, 8.98, 8.33, 5.19, 8.91, 8.59, 3.47, 3.46, 7.91, 3.56, 12.82, 8.52, 8.63,
  8.92, 8.91, 5.48, 7.62, 5.21, 8.52, 7.9, 11.38, 7.63, 7.91, 7.85, 5.49, 3.65, 5.49, 9.21,
]
const FONT_SIZE = 15
const LINE_HEIGHT = 20
const PAD_X = 12
const PAD_Y = 7
const RADIUS = 17
const TAIL = 6
const MAX_LINE = 420
// An Svg's source is capped at 131072 characters.
const MAX_SVG = 130_000
const FONT_FAMILY = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif"

const charWidth = (ch: string) => {
  const code = ch.codePointAt(0) ?? 0

  if (code >= 32 && code <= 126) {
    return SF_15[code - 32]
  }

  // CJK and emoji run about one em; rounded up so a line never overflows its bubble.
  return code > 0x2e80 ? FONT_SIZE * 1.25 : 9.5
}

const measure = (line: string) => [...line].reduce((sum, ch) => sum + charWidth(ch), 0)

const wrap = (text: string) => {
  const lines: string[] = []

  for (const paragraph of text.split('\n')) {
    let line = ''

    for (const word of paragraph.split(/(\s+)/)) {
      if (word === '') {
        continue
      }

      if (measure((line + word).trimEnd()) <= MAX_LINE) {
        line += word
        continue
      }

      if (line.trim() !== '') {
        lines.push(line.trimEnd())
      }

      line = /^\s+$/.test(word) ? '' : word

      // A word wider than a line breaks wherever it has to.
      while (measure(line) > MAX_LINE) {
        let cut = line.length

        while (cut > 1 && measure(line.slice(0, cut)) > MAX_LINE) {
          cut--
        }

        lines.push(line.slice(0, cut))
        line = line.slice(cut)
      }
    }

    lines.push(line.trimEnd())
  }

  return lines
}

const escapeXml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const sentBubble = (text: string, fill: string) => {
  const lines = wrap(text)
  const height = lines.length * LINE_HEIGHT + PAD_Y * 2
  const width = Math.max(Math.ceil(Math.max(...lines.map(measure)) + PAD_X * 2 + 1), height)
  const r = Math.min(RADIUS, height / 2)
  const outline = [
    `M${r},0`,
    `H${width - r}`,
    `A${r},${r} 0 0 1 ${width},${r}`,
    `V${height - r}`,
    // The tail: down the right edge to a point past the corner, then back into the bottom edge.
    `C${width},${height - 5} ${width + 1.5},${height - 1} ${width + TAIL},${height}`,
    `C${width + 1},${height} ${width - 2.5},${height - 1.2} ${width - 6},${height - 3}`,
    `C${width - 9},${height - 1} ${width - 12},${height} ${width - r},${height}`,
    `H${r}`,
    `A${r},${r} 0 0 1 0,${height - r}`,
    `V${r}`,
    `A${r},${r} 0 0 1 ${r},0`,
    'Z',
  ].join(' ')
  const rows = lines
    .map((line, i) => `<text x="${PAD_X}" y="${PAD_Y + LINE_HEIGHT * i + 15}" xml:space="preserve">${escapeXml(line)}</text>`)
    .join('')

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width + TAIL}" height="${height}" viewBox="0 0 ${width + TAIL} ${height}">`,
    `<path d="${outline}" fill="${fill}"/>`,
    `<g font-family="${escapeXml(FONT_FAMILY)}" font-size="${FONT_SIZE}" fill="#FFFFFF">${rows}</g>`,
    '</svg>',
  ].join('')
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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'imessage',
      description: 'Turn iMessage-style chat bubbles on or off',
      argumentHint: '[on|off]',
      immediate: true,
    })
    const saved = await $.store.get('isOn')
    await update($, isOn, () => saved !== false)
    await refreshMode($)
    $.clock.every(20_000, () => void refreshMode($))

    return started
  })

  on('command.run', { command: 'imessage' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const wasOn = await read($, isOn)
    const next = arg === 'on' ? true : arg === 'off' ? false : !wasOn
    await update($, isOn, () => next)
    await $.store.set('isOn', next)

    return { text: next ? 'iMessage bubbles on.' : 'iMessage bubbles off. Run /imessage to turn them back on.' }
  })

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const isOwnPrompt = OWN_PROMPTS.has(e.props.origin.kind) && !e.props.from && !e.props.task

    const text = clean(e.props.text)

    if (!(await read($, isOn)) || !isOwnPrompt || text.trim() === '' || text.length > MAX_TEXT) {
      return next(e)
    }

    const { blue } = PALETTE[await read($, mode)]

    if (e.surface !== 'terminal') {
      const source = sentBubble(text, blue)

      if (source.length <= MAX_SVG) {
        const { Box, Svg } = $.ui.resolve(e)

        // No width or height: the image keeps its own size and scales down in a narrow window.
        return (
          <Box width="100%" flexDirection="row" justifyContent="flex-end">
            <Svg source={source} alt={text} />
          </Box>
        )
      }
    }

    // The terminal has no Svg; it gets the closest box the cells allow.
    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box width="100%" flexDirection="row">
        <Box flexGrow={1} minWidth="25%" />
        <Box
          flexShrink={1}
          backgroundColor={blue}
          borderStyle="round"
          borderColor={blue}
          paddingX={1}
        >
          <Text color="#FFFFFF" wrap="wrap">
            {text}
          </Text>
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const text = clean(e.props.text)

    if (!(await read($, isOn)) || text.trim() === '' || text.length > MAX_TEXT) {
      return next(e)
    }

    const { gray } = PALETTE[await read($, mode)]
    const { Box, Markdown } = $.ui.resolve(e)

    return (
      <Box width="100%" flexDirection="row">
        <Box
          flexShrink={1}
          backgroundColor={gray}
          borderStyle="round"
          borderColor={gray}
          paddingX={1}
        >
          <Markdown text={text} />
        </Box>
        <Box flexGrow={1} minWidth="20%" />
      </Box>
    )
  })
}
