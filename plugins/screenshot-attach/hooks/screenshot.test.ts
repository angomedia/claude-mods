import { expect, mock, test } from 'claude-code/testing'

const HOME = '/Users/me'
const NOW = Date.UTC(2026, 9, 3, 20, 45)
const MINUTE = 60_000

// The Desktop: three screenshots, newest last-modified first once sorted, and other files.
const desktop = [
  { name: 'Screenshot 2026-10-03 at 8.26.37 PM.png', kind: 'file', size: 1, mtimeMs: NOW - 19 * MINUTE, isLink: false },
  { name: 'Screenshot 2026-10-03 at 8.41.21 PM.png', kind: 'file', size: 1, mtimeMs: NOW - 4 * MINUTE, isLink: false },
  { name: 'notes.txt', kind: 'file', size: 1, mtimeMs: NOW, isLink: false },
  { name: 'holiday.png', kind: 'file', size: 1, mtimeMs: NOW - MINUTE, isLink: false },
  { name: 'Screenshot 2026-10-03 at 8.39.18 PM.png', kind: 'file', size: 1, mtimeMs: NOW - 6 * MINUTE, isLink: false },
  { name: 'Screenshots', kind: 'dir', size: 0, mtimeMs: 0, isLink: false },
]

const setup = async ($: any, on: any, files: readonly unknown[] = desktop) => {
  const sent: { text: string; context?: string[] }[] = []
  const toasts: string[] = []
  const statuses: (string | undefined)[] = []
  mock.clock(on, { now: NOW })
  mock.env(on, { HOME })
  // No screenshot location set in macOS: the Desktop.
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: 'does not exist' } }) as any)
  on('fs.exists', () => ({ value: true }) as any)
  on('fs.list', (_$: unknown, e: { path?: string }) => ({ value: e.path === `${HOME}/Desktop` ? files : [] }) as any)
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }) as any)
  on('ui.toast', (_$: unknown, e: { text: string }) => {
    toasts.push(e.text)
    return { value: undefined } as any
  })
  on('ui.status', (_$: unknown, e: { text?: string }) => {
    statuses.push(e.text)
    return { value: undefined } as any
  })
  on('prompt.submit', (_$: unknown, e: { text: string; context?: string[] }) => {
    sent.push({ text: e.text, context: e.context })
    return { text: e.text, context: e.context }
  })
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })

  return { sent, toasts, statuses }
}

const send = ($: any, text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })

test(';;ss attaches the latest screenshot and leaves the rest of the message', async ($, on) => {
  const { sent, toasts } = await setup($, on)
  await send($, 'why is this button gray? ;;ss')

  expect(sent.at(-1)?.text).toBe('why is this button gray?')
  const context = sent.at(-1)?.context?.join('\n') ?? ''
  expect(context).toContain(`${HOME}/Desktop/Screenshot 2026-10-03 at 8.41.21 PM.png (taken 4 min ago)`)
  expect(context).not.toContain('8.39.18')
  expect(context).not.toContain('holiday.png')
  expect(context).toContain('Read tool')
  expect(toasts).toEqual(['📎 Attached Screenshot 8.41.21 PM (4 min ago)'])
})

test(';;ss3 attaches the last three, newest first', async ($, on) => {
  const { sent } = await setup($, on)
  await send($, ';;ss3')
  const context = sent.at(-1)?.context?.join('\n') ?? ''

  expect(sent.at(-1)?.text).toBe('Here are my last 3 screenshots.')
  expect(context.indexOf('8.41.21')).toBeLessThan(context.indexOf('8.39.18'))
  expect(context.indexOf('8.39.18')).toBeLessThan(context.indexOf('8.26.37'))
})

test('/ss 2 arms the next message, then lets go', async ($, on) => {
  const { sent, statuses } = await setup($, on)
  const armed = await $.command.run({ command: 'ss', args: '2' })
  expect(armed.text).toContain('last 2 screenshots')
  expect(statuses.at(-1)).toBe('📎 2 screenshots will go with your next message')

  await send($, 'compare these two')
  expect(sent.at(-1)?.text).toBe('compare these two')
  expect(sent.at(-1)?.context?.join('\n')).toContain('8.39.18')
  expect(statuses.at(-1)).toBeUndefined()

  await send($, 'thanks')
  expect(sent.at(-1)?.context).toBeUndefined()
})

test('leaves messages without ;;ss alone, and ;;ss inside a word', async ($, on) => {
  const { sent } = await setup($, on)
  await send($, 'see a;;ss there')

  expect(sent.at(-1)).toEqual({ text: 'see a;;ss there', context: undefined })
})

test('says so when there are no screenshots', async ($, on) => {
  const { sent, toasts } = await setup($, on, [])
  await send($, 'look ;;ss')

  expect(sent.at(-1)?.context).toBeUndefined()
  expect(toasts.at(-1)).toContain('No screenshots found in ~/Desktop')
})
