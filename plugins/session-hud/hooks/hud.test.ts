import { expect, mock, test } from 'claude-code/testing'

const band = { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 120 } as any

const usage = {
  startedAt: Date.now() - 2 * 3_600_000,
  context: { tokens: 383_000, window: 1_000_000, percent: 38 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 3, resetsAt: new Date(Date.now() + 4 * 3_600_000).toISOString() },
    { kind: 'seven_day', percentUsed: 26, resetsAt: new Date(Date.now() + 3 * 86_400_000).toISOString() },
  ],
  cost: { usd: 16.784 },
}

const setup = async ($: any, on: any, calls: string[] = []) => {
  mock.clock(on, { now: Date.now() })
  mock.store(on)
  on('session.usage', () => ({ value: usage }))
  on('session.model', () => ({ value: 'claude-opus-5-5[1m]' }))
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }) as any)
  on('command.list', () => ({ value: [{ name: 'clear' }, { name: 'compact' }] }) as any)
  on('command.run', (_$: unknown, e: { command: string }) => {
    calls.push(`/${e.command}`)
    return { text: '' }
  })
  on('model.fork', () => {
    calls.push('fork')
    return { value: { isAnswered: true, text: 'Goal: ship the HUD.', usage: {} } } as any
  })
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }) as any)
  on('ui.toast', (_$: unknown, e: { text: string }) => { calls.push('toast: ' + e.text); return { value: undefined } as any })
  on('ui.render', () => ({ type: 'engine', ref: 1 }) as const)
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
}

for (const surface of ['desktop', 'terminal'] as const) {
  test(`draws the card on the ${surface}`, async ($, on) => {
    await setup($, on)
    const ui = await $.ui.mount({ plugin: 'session-hud', surface, component: 'AbovePrompt', props: band })
    const drawn = JSON.stringify(await ui.drawn())

    expect(drawn).toContain('383k of 1M tokens')
    expect(drawn).toContain('5-hour limit')
    expect(drawn).toMatch(/resets in 4h \d+m/)
    expect(drawn).toContain('Weekly limit')
    expect(drawn).toContain('API ≈ $16.78')
    expect(drawn).toContain('"label":"Compact"')
    expect(drawn).toContain('"label":"Fresh start"')
    // The desktop shows the model under the message box already.
    expect(drawn.includes('Opus 5.5 1M')).toBe(surface !== 'desktop')
  })
}

test('Compact runs /compact', async ($, on) => {
  const calls: string[] = []
  await setup($, on, calls)
  const ui = await $.ui.mount({ plugin: 'session-hud', surface: 'desktop', component: 'AbovePrompt', props: band })
  await ui.press({ key: 'compact' })

  expect(calls).toContain('/compact')
})

test('Fresh start asks first, then hands off and clears', async ($, on) => {
  const calls: string[] = []
  await setup($, on, calls)
  const ui = await $.ui.mount({ plugin: 'session-hud', surface: 'desktop', component: 'AbovePrompt', props: band })

  await ui.press({ key: 'fresh' })
  expect(calls).toEqual([])
  expect(JSON.stringify(await ui.drawn())).toContain('Press again to start fresh')

  await ui.press({ key: 'fresh' })
  // The note is written before anything is cleared. (The test kit can't stand in for
  // session.append, so the two rows that follow /clear aren't checked here.)
  expect(calls.slice(0, 2)).toEqual(['fork', '/clear'])
})
