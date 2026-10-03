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
