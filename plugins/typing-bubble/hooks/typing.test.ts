import { expect, mock, test } from 'claude-code/testing'

const spinner = (word: string, mode = 'responding') => ({ word, message: null, suffix: '…', mode }) as any

const setup = async ($: any, on: any) => {
  const clock = mock.clock(on, { now: Date.now() })
  mock.store(on)
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.surfaces', () => ({ value: ['terminal'] }) as any)
  on('command.register', () => ({ value: undefined }) as any)
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'light\n', stderr: '' } }) as any)
  on('turn.start', (_$: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.render', () => ({ type: 'engine', ref: 1 }) as const)
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })

  return clock
}

const band = (isWorking: boolean) => ({ hasSurvey: false, isWorking, maxRows: 10, bodyColumns: 120, scroll: {}, view: {} }) as any

test('draws an animated one-line typing bubble in the spinner row on the desktop', async ($, on) => {
  await setup($, on)
  const ui = await $.ui.mount({ plugin: 'typing-bubble', surface: 'desktop', component: 'Spinner', props: spinner('Working') })
  const drawn = JSON.stringify(await ui.drawn())

  expect(drawn).toContain('"type":"Svg"')
  expect(drawn).toContain('"isInteractive":true')
  expect(drawn).toContain('<animate')
  expect(drawn).toContain('"width":40')
  expect(drawn).toContain('"height":18')
  // It stands in for the row: the app's own spinner isn't drawn, and "Working" says nothing.
  expect(drawn).not.toContain('"type":"engine"')
  expect(drawn).not.toContain('Working')
})

test("says what Claude is doing beside the bubble, in the row's own words", async ($, on) => {
  await setup($, on)
  const ui = await $.ui.mount({ plugin: 'typing-bubble', surface: 'desktop', component: 'Spinner', props: spinner('Editing notes.md') })

  expect(JSON.stringify(await ui.drawn())).toContain('Editing notes.md')
})

test("leaves the band above the message box to other mods, so it's never inside session-hud's card", async ($, on) => {
  await setup($, on)
  const ui = await $.ui.mount({ plugin: 'typing-bubble', surface: 'desktop', component: 'AbovePrompt', props: band(true) })
  const drawn = JSON.stringify(await ui.drawn())

  expect(drawn).toContain('"type":"engine"')
  expect(drawn).not.toContain('Svg')
})

test('steps the dots in the terminal while a turn runs', async ($, on) => {
  const clock = await setup($, on)
  const ui = await $.ui.mount({ plugin: 'typing-bubble', surface: 'terminal', component: 'Spinner', props: spinner('Baking') })
  const before = JSON.stringify(await ui.drawn())

  await $.turn.start({ text: 'hi', turnId: 't1' })
  await clock.advance(350)
  const after = JSON.stringify(await ui.drawn())

  expect(before).toContain('●')
  expect(after).not.toEqual(before)

  // The dots stop when the turn ends.
  await $.turn.complete({ answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' } as any)
  const stopped = JSON.stringify(await ui.drawn())
  await clock.advance(1_000)
  expect(JSON.stringify(await ui.drawn())).toEqual(stopped)
})

test('/typing off gives the spinner back', async ($, on) => {
  await setup($, on)
  await $.command.run({ command: 'typing', args: 'off' } as any)
  const spinnerRow = await $.ui.mount({ plugin: 'typing-bubble', surface: 'desktop', component: 'Spinner', props: spinner('Working') })
  const drawn = JSON.stringify(await spinnerRow.drawn())

  expect(drawn).toContain('"type":"engine"')
  expect(drawn).not.toContain('Svg')
})
