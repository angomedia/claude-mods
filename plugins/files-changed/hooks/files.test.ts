import { expect, mock, test } from 'claude-code/testing'

const pane = { title: 'Files changed', isFocused: false, bodyColumns: 40, placement: 'dock', scroll: {}, view: {} } as any

const setup = async ($: any, on: any) => {
  const ran: string[][] = []
  const opened: string[] = []
  const toasts: string[] = []
  mock.clock(on, { now: Date.now() })
  mock.store(on)
  on('session.root', () => ({ value: '/work/app' }) as any)
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }) as any)
  on('ui.panes', () => ({ value: opened.map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })) }) as any)
  on('ui.open', (_$: unknown, e: { id: string }) => {
    opened.push(e.id)
    return { value: { isPlaced: true } } as any
  })
  on('ui.close', (_$: unknown, e: { id: string }) => {
    opened.splice(opened.indexOf(e.id), 1)
    return { value: undefined } as any
  })
  on('ui.toast', (_$: unknown, e: { text: string }) => {
    toasts.push(e.text)
    return { value: undefined } as any
  })
  on('process.run', (_$: unknown, e: { argv: string[] }) => {
    ran.push(e.argv)
    return { value: { exitCode: 0, stdout: '', stderr: '' } } as any
  })
  on('tool.call', (_$: unknown, e: any) => {
    if (e.tool === 'Edit') {
      return { result: { filePath: e.file_path, structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ['-a', '+b', '+c'] }] } }
    }
    if (e.tool === 'Write') return { result: { type: 'create', filePath: e.file_path, content: 'x\ny\n', structuredPatch: [], originalFile: null } }
    return { result: {} }
  })
  on('ui.render', () => ({ type: 'engine', ref: 1 }) as const)
  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })

  return { ran, opened, toasts }
}

const edit = ($: any, path: string) => $.tool.call({ tool: 'Edit', tool_use_id: path, file_path: path, old_string: 'a', new_string: 'b\nc' })

test('lists each changed file with its lines added and removed', async ($, on) => {
  const { toasts } = await setup($, on)
  await edit($, '/work/app/src/app.ts')
  await edit($, '/work/app/src/app.ts')
  await $.tool.call({ tool: 'Write', tool_use_id: 'w', file_path: '/work/app/README.md', content: 'x\ny\n' })
  await $.tool.call({ tool: 'Read', tool_use_id: 'r', file_path: '/work/app/other.ts' })

  const ui = await $.ui.mount({ plugin: 'files-changed', surface: 'desktop', component: 'Pane', requestId: 'files-changed', props: pane })
  const drawn = JSON.stringify(await ui.drawn())

  expect(drawn).toContain('2 files')
  expect(drawn).toContain('"label":"app.ts"')
  expect(drawn).toContain('src/')
  expect(drawn).toContain('2 edits')
  expect(drawn).toContain('"label":"README.md"')
  expect(drawn).toContain('new')
  expect(drawn).not.toContain('other.ts')
  expect(toasts).toHaveLength(1)
})

test('clicking a file opens it', async ($, on) => {
  const { ran } = await setup($, on)
  await edit($, '/work/app/src/app.ts')
  const ui = await $.ui.mount({ plugin: 'files-changed', surface: 'desktop', component: 'Pane', requestId: 'files-changed', props: pane })
  await ui.press({ key: 'open:/work/app/src/app.ts' })

  expect(ran.at(-1)).toEqual(['/usr/bin/open', '-a', 'Visual Studio Code', '/work/app/src/app.ts'])
})

test('/files opens and closes the pane', async ($, on) => {
  const { opened } = await setup($, on)
  await $.command.run({ command: 'files', args: '' })
  expect(opened).toEqual(['files-changed'])

  await $.command.run({ command: 'files', args: '' })
  expect(opened).toEqual([])
})

for (const surface of ['desktop', 'terminal'] as const) {
  test(`says so when nothing changed yet on the ${surface}`, async ($, on) => {
    await setup($, on)
    const ui = await $.ui.mount({ plugin: 'files-changed', surface, component: 'Pane', requestId: 'files-changed', props: pane })

    expect(JSON.stringify(await ui.drawn())).toContain('No files changed yet.')
  })
}
