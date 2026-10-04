import { expect, mock, test } from 'claude-code/testing'

const MINUTE = 60_000

const setup = async ($: any, on: any) => {
  const statuses: (string | undefined)[] = []
  const toasts: string[] = []
  const ran: string[][] = []
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 3, 9, 0) })
  mock.store(on)
  mock.env(on, {})
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.surface', () => ({ value: 'desktop' }) as any)
  on('command.register', () => ({ value: undefined }) as any)
  on('prompt.submit', (_$: unknown, e: { text: string }) => ({ text: e.text }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.status', (_$: unknown, e: { text?: string }) => {
    statuses.push(e.text)
    return { value: undefined } as any
  })
  on('ui.toast', (_$: unknown, e: { text: string }) => {
    toasts.push(e.text)
    return { value: undefined } as any
  })
  on('process.run', (_$: unknown, e: { argv: string[] }) => {
    ran.push(e.argv)
    return { value: { exitCode: 0, stdout: '"LSDisplayName"="Claude"', stderr: '' } } as any
  })
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })

  // Someone sends a message every few minutes.
  const work = async (minutes: number) => {
    for (let i = 0; i < minutes; i += 5) {
      await clock.advance(5 * MINUTE)
      await $.prompt.submit({ text: 'next', wait: false, origin: { kind: 'composer' } })
      await clock.settle()
    }
  }

  return { statuses, toasts, ran, clock, work }
}

test('counts down to the next break in the status line', async ($, on) => {
  const { statuses, work } = await setup($, on)
  expect(statuses.at(-1)).toBe('☕ Break in 50m')

  await work(20)
  expect(statuses.at(-1)).toBe('☕ Break in 30m')
})

test('reminds you once after 50 minutes of work, with a sound', async ($, on) => {
  const { statuses, toasts, ran, work } = await setup($, on)
  await work(50)

  expect(statuses.at(-1)).toBe('☕ Time for a break · 50m of work')
  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toContain('Time for a break')
  expect(ran.some(argv => argv[0] === '/usr/bin/afplay')).toBe(true)
  // Claude is in front, so no banner on top of the toast.
  expect(ran.some(argv => argv[0] === '/usr/bin/osascript')).toBe(false)

  await work(10)
  expect(toasts).toHaveLength(1)
})

test('time away counts as a break', async ($, on) => {
  const { statuses, toasts, clock, work } = await setup($, on)
  await work(40)
  await clock.advance(12 * MINUTE)
  await $.prompt.submit({ text: 'back', wait: false, origin: { kind: 'composer' } })
  await clock.settle()

  expect(statuses.at(-1)).toBe('☕ Break in 50m')
  expect(toasts).toHaveLength(0)
})

test('/break done restarts the timer and /break every changes it', async ($, on) => {
  const { statuses, work } = await setup($, on)
  await work(30)
  await $.command.run({ command: 'break', args: 'every 25' })
  expect(statuses.at(-1)).toBe('☕ Time for a break · 30m of work')

  await $.command.run({ command: 'break', args: 'done' })
  expect(statuses.at(-1)).toBe('☕ Break in 25m')
})

test('/break off clears the status line', async ($, on) => {
  const { statuses } = await setup($, on)
  await $.command.run({ command: 'break', args: 'off' })

  expect(statuses.at(-1)).toBeUndefined()
})
