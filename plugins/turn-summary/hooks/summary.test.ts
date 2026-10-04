import { expect, mock, test } from 'claude-code/testing'

const editResult = (filePath: string, lines: string[]) => ({
  filePath,
  oldString: 'a',
  newString: 'b',
  originalFile: 'a',
  structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines }],
  userModified: false,
  replaceAll: false,
})

const setup = async ($: any, on: any, surface: 'desktop' | 'terminal' = 'desktop') => {
  const statuses: (string | undefined)[] = []
  mock.clock(on, { now: Date.now() })
  mock.store(on)
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.surface', () => ({ value: surface }) as any)
  on('command.register', () => ({ value: undefined }) as any)
  on('turn.start', (_$: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.status', (_$: unknown, e: { text?: string }) => {
    statuses.push(e.text)
    return { value: undefined } as any
  })
  on('tool.call', (_$: unknown, e: any) => {
    if (e.tool === 'Edit') return { result: editResult(e.file_path, ['-old line', '+new line', '+another']) }
    if (e.tool === 'Write') return { result: { type: 'create', filePath: e.file_path, content: 'one\ntwo\nthree\n', structuredPatch: [], originalFile: null } }
    return { result: { stdout: '', stderr: '' } }
  })
  on('ui.render', () => ({ type: 'engine', ref: 1 }) as const)
  await $.session.start({ cwd: '/tmp', surface, isInteractive: true })

  return statuses
}

const runTurn = async ($: any, durationMs: number) => {
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'Read', tool_use_id: 'a', file_path: '/p/a.ts' })
  await $.tool.call({ tool: 'Edit', tool_use_id: 'b', file_path: '/p/src/app.ts', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Write', tool_use_id: 'c', file_path: '/p/notes.md', content: 'one\ntwo\nthree\n' })
  await $.turn.complete({ answer: 'ok', durationMs, isAborted: false, turnId: 't1', reason: 'answer' } as any)
}

test('puts the summary in the status line on the desktop', async ($, on) => {
  const statuses = await setup($, on)
  await runTurn($, 134_000)

  expect(statuses.at(-1)).toBe('Last reply · 2m 14s · 3 tools · app.ts, notes.md +5 −1')
})

test('adds the summary to the turn footer in the terminal', async ($, on) => {
  const statuses = await setup($, on, 'terminal')
  await runTurn($, 12_000)
  const ui = await $.ui.mount({ plugin: 'turn-summary', surface: 'terminal', component: 'TurnDuration', props: { word: 'Baked', durationMs: 12_000 } })

  expect(JSON.stringify(await ui.drawn())).toContain('Baked for 12s · 3 tools · app.ts, notes.md +5 −1')
  // The footer says it; no status line too.
  expect(statuses).toHaveLength(0)
})

test('/summary off leaves the footer alone', async ($, on) => {
  await setup($, on, 'terminal')
  await $.command.run({ command: 'summary', args: 'off' })
  await runTurn($, 12_000)
  const ui = await $.ui.mount({ plugin: 'turn-summary', surface: 'terminal', component: 'TurnDuration', props: { word: 'Baked', durationMs: 12_000 } })

  expect(JSON.stringify(await ui.drawn())).toContain('"type":"engine"')
})
