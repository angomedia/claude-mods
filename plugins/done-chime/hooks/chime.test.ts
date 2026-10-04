import { expect, mock, test } from 'claude-code/testing'

const setup = async ($: any, on: any, surface: 'desktop' | 'terminal' = 'desktop') => {
  on('tool.call', () => ({ result: { answers: {} } }) as any)
  const ran: string[][] = []
  const clock = mock.clock(on, { now: Date.now() })
  mock.store(on)
  mock.env(on, { TERM_PROGRAM: 'Apple_Terminal' })
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.surface', () => ({ value: surface }) as any)
  on('command.register', () => ({ value: undefined }) as any)
  on('turn.complete', () => ({ text: '' }))
  on('process.run', (_$: unknown, e: { argv: string[] }) => {
    ran.push(e.argv)
    // Someone is looking at another app.
    return { value: { exitCode: 0, stdout: '"LSDisplayName"="Safari"', stderr: '' } } as any
  })
  await $.session.start({ cwd: '/tmp', surface, isInteractive: true })

  return { ran, clock }
}

const turn = (durationMs: number) => ({ answer: '## Done\nAll tests pass.', durationMs, isAborted: false, turnId: 't1', reason: 'answer' }) as any
const played = (ran: string[][]) => ran.filter(argv => argv[0] === '/usr/bin/afplay').map(argv => argv[1])
const banners = (ran: string[][]) => ran.filter(argv => argv[0] === '/usr/bin/osascript')

test('chimes with the iMessage tone after a long reply', async ($, on) => {
  const { ran, clock } = await setup($, on)
  await $.turn.complete(turn(45_000))
  await clock.settle()

  expect(played(ran)).toEqual([expect.stringContaining('ReceivedMessage.caf')])
  // The desktop app has its own notifications.
  expect(banners(ran)).toHaveLength(0)
})

test('chimes after every reply by default, even a quick one', async ($, on) => {
  const { ran, clock } = await setup($, on)
  await $.turn.complete(turn(2_000))
  await clock.settle()

  expect(played(ran)).toHaveLength(1)
})

test('stays quiet after an interrupted reply', async ($, on) => {
  const { ran, clock } = await setup($, on)
  await $.turn.complete({ ...turn(45_000), isAborted: true, reason: 'aborted' })
  await clock.settle()

  expect(played(ran)).toHaveLength(0)
})

test('shows a banner from the terminal when you are in another app', async ($, on) => {
  const { ran, clock } = await setup($, on, 'terminal')
  await $.turn.complete(turn(45_000))
  await clock.settle()

  expect(banners(ran)).toHaveLength(1)
  expect(banners(ran)[0]).toContain('All tests pass.')
})

test('/chime off and /chime after change when it plays', async ($, on) => {
  const { ran, clock } = await setup($, on)
  await $.command.run({ command: 'chime', args: 'after 120' })
  await $.turn.complete(turn(90_000))
  await clock.settle()
  expect(played(ran)).toHaveLength(0)

  await $.command.run({ command: 'chime', args: 'after 10' })
  await $.command.run({ command: 'chime', args: 'off' })
  await $.turn.complete(turn(90_000))
  await clock.settle()
  expect(played(ran)).toHaveLength(0)
})

test('chimes when Claude asks a question', async ($, on) => {
  const { ran, clock } = await setup($, on)
  await $.tool.call({ tool: 'AskUserQuestion', tool_use_id: 'q1', questions: [{ question: 'Which color?', header: 'Color', options: [], multiSelect: false }] } as any)
  await clock.settle()

  expect(played(ran)).toEqual([expect.stringContaining('QuestionMark.caf')])
})
