import { expect, mock, test } from 'claude-code/testing'

const HOME = '/Users/me'
const FILE = `${HOME}/.claude/notes/-work-my-app.md`
const pane = { title: 'Notes', isFocused: true, bodyColumns: 40, placement: 'dock', scroll: {}, view: {} } as any

const setup = async ($: any, on: any, disk: Record<string, string> = {}) => {
  const opened: string[] = []
  const ran: string[][] = []
  mock.clock(on, { now: Date.now() })
  mock.store(on)
  mock.env(on, { HOME })
  on('fs.exists', (_$: unknown, e: { path: string }) => ({ value: e.path in disk }) as any)
  on('fs.read', (_$: unknown, e: { path: string }) => ({ value: disk[e.path] }) as any)
  on('fs.write', (_$: unknown, e: { path: string; text: string }) => {
    disk[e.path] = e.text
    return { value: undefined } as any
  })
  on('session.root', () => ({ value: '/work/my-app' }) as any)
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
  on('process.run', (_$: unknown, e: { argv: string[] }) => {
    ran.push(e.argv)
    return { value: { exitCode: 0, stdout: '', stderr: '' } } as any
  })
  on('ui.render', () => ({ type: 'engine', ref: 1 }) as const)
  await $.session.start({ cwd: '/work/my-app', surface: 'desktop', isInteractive: true })

  return { disk, opened, ran }
}

const mountPane = ($: any, surface: 'desktop' | 'terminal' = 'desktop') =>
  $.ui.mount({ plugin: 'project-notes', surface, component: 'Pane', requestId: 'notes', props: pane })

test('/note adds to a Markdown checklist for this project', async ($, on) => {
  const { disk } = await setup($, on)
  await $.command.run({ command: 'note', args: 'check the logo on dark mode' })
  await $.command.run({ command: 'note', args: 'ask about the launch date' })

  expect(disk[FILE]).toBe('- [ ] check the logo on dark mode\n- [ ] ask about the launch date\n')
})

test('the pane adds, ticks and removes notes', async ($, on) => {
  const { disk } = await setup($, on, { [FILE]: '# Launch\n- [ ] first\n- second\n' })
  const ui = await mountPane($)
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('Launch')
  expect(drawn).toContain('first')
  expect(drawn).toContain('second')

  await ui.input({ key: 'add-0', text: 'third' })
  expect(disk[FILE]).toBe('# Launch\n- [ ] first\n- second\n- [ ] third\n')

  await ui.press({ key: 'toggle:1' })
  await ui.press({ key: 'toggle:2' })
  expect(disk[FILE]).toBe('# Launch\n- [x] first\n- [x] second\n- [ ] third\n')

  await ui.press({ key: 'clear' })
  expect(disk[FILE]).toBe('# Launch\n- [ ] third\n')

  await ui.press({ key: 'delete:1' })
  expect(disk[FILE]).toBe('# Launch\n')
})

test('/notes opens and closes the pane, titled with the project', async ($, on) => {
  const { opened } = await setup($, on)
  const answer = await $.command.run({ command: 'notes', args: '' })
  expect(opened).toEqual(['notes'])
  expect(answer.text).toContain('my-app')

  await $.command.run({ command: 'notes', args: '' })
  expect(opened).toEqual([])
})

test('/notes edit opens the file in a text editor', async ($, on) => {
  const { ran } = await setup($, on)
  await $.command.run({ command: 'notes', args: 'edit' })

  expect(ran.at(-1)).toEqual(['/usr/bin/open', '-t', FILE])
})

for (const surface of ['desktop', 'terminal'] as const) {
  test(`shows a friendly empty state on the ${surface}`, async ($, on) => {
    await setup($, on)
    const ui = await mountPane($, surface)

    expect(JSON.stringify(await ui.drawn())).toContain('No notes yet for my-app')
  })
}
