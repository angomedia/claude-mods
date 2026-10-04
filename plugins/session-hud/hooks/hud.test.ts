import { expect, mock, test } from 'claude-code/testing'

const band = { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 100 } as any

const usage = {
  startedAt: 0,
  context: { tokens: 76_000, window: 200_000, percent: 38 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 23.5, resetsAt: new Date(Date.now() + 2 * 3_600_000).toISOString() },
    { kind: 'seven_day', percentUsed: 91, resetsAt: new Date(Date.now() + 3 * 86_400_000).toISOString() },
  ],
  cost: { usd: 1.234 },
}

const setup = async ($: any, on: any) => {
  mock.clock(on, { now: Date.now() })
  mock.store(on)
  on('session.usage', () => ({ value: usage }))
  on('session.model', () => ({ value: 'claude-opus-5-5[1m]' }))
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }) as any)
  on('ui.render', () => ({ type: 'engine', ref: 1 }) as const)
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
}

for (const surface of ['desktop', 'terminal'] as const) {
  test(`draws the card on the ${surface}`, async ($, on) => {
    await setup($, on)
    const ui = await $.ui.mount({ plugin: 'session-hud', surface, component: 'AbovePrompt', props: band })
    const drawn = JSON.stringify(await ui.drawn())

    expect(drawn).toContain('Opus 5.5 1M')
    expect(drawn).toContain('38%')
    expect(drawn).toContain('76k/200k')
    expect(drawn).toContain('5h')
    expect(drawn).toContain('24%')
    expect(drawn).toContain('$1.23')
    expect(drawn).toContain(surface === 'terminal' ? '█' : '"type":"Svg"')
  })
}
