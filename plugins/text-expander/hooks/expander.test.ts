import { expect, mock, test } from 'claude-code/testing'

const HOME = '/Users/me'
const YOURS = `${HOME}/.claude/snippets.json`
const PROJECT = '/work/app/.claude/snippets.json'

// A small disk in memory, standing in for $.fs.
const setup = async ($: any, on: any, disk: Record<string, string> = {}) => {
  const toasts: string[] = []
  const submitted: string[] = []
  const opened: string[] = []
  mock.store(on)
  mock.env(on, { HOME })
  on('fs.exists', (_$: unknown, e: { path: string }) => ({ value: e.path in disk }) as any)
  on('fs.read', (_$: unknown, e: { path: string }) => {
    if (!(e.path in disk)) throw new Error(`ENOENT ${e.path}`)
    return { value: disk[e.path] } as any
  })
  on('fs.write', (_$: unknown, e: { path: string; text: string }) => {
    disk[e.path] = e.text
    return { value: undefined } as any
  })
  on('session.root', () => ({ value: '/work/app' }) as any)
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }) as any)
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }) as any)
  on('ui.toast', (_$: unknown, e: { text: string }) => {
    toasts.push(e.text)
    return { value: undefined } as any
  })
  on('ui.panes', () => ({ value: opened.map(id => ({ id, title: id, isShown: true, isFocused: true, isPlaced: true })) }) as any)
  on('ui.open', (_$: unknown, e: { id: string }) => {
    opened.push(e.id)
    return { value: { isPlaced: true } } as any
  })
  on('ui.close', (_$: unknown, e: { id: string }) => {
    opened.splice(opened.indexOf(e.id), 1)
    return { value: undefined } as any
  })
  on('ui.focus', () => ({ value: {} }) as any)
  on('ui.render', () => ({ type: 'engine', ref: 1 }) as const)
  on('prompt.submit', (_$: unknown, e: { text: string }) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })

  return { disk, toasts, submitted, opened }
}

const send = ($: any, text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })

test('writes starter snippets the first time', async ($, on) => {
  const { disk } = await setup($, on)

  expect(JSON.parse(disk[YOURS])[';;t']).toContain('Run the tests')
})

test('expands a trigger when you send it', async ($, on) => {
  const { submitted, toasts } = await setup($, on)
  await send($, ';;t please, then ;;s')

  expect(submitted.at(-1)).toBe(
    "Run the tests and fix anything that fails. Tell me what you changed. please, then Summarize what you did, what you checked, and what's left, in a few bullets.",
  )
  expect(toasts).toEqual(['Expanded ;;t, ;;s'])
})

test('leaves triggers inside words alone', async ($, on) => {
  const { submitted } = await setup($, on)
  await send($, 'a;;t and x;;tt')

  expect(submitted.at(-1)).toBe('a;;t and x;;tt')
})

test("this project's snippets win over yours", async ($, on) => {
  const { submitted } = await setup($, on, { [PROJECT]: JSON.stringify({ ';;t': 'Run npm test.' }) })
  await send($, ';;t')

  expect(submitted.at(-1)).toBe('Run npm test.')
})

test('/snippets add, list and remove', async ($, on) => {
  const { disk, submitted } = await setup($, on)

  await $.command.run({ command: 'snippets', args: 'add ;;hi Hello there, Claude!' })
  expect(JSON.parse(disk[YOURS])[';;hi']).toBe('Hello there, Claude!')

  await $.command.run({ command: 'snippets', args: 'add-here ;;deploy Run the deploy script.' })
  expect(JSON.parse(disk[PROJECT])[';;deploy']).toBe('Run the deploy script.')

  const listed = await $.command.run({ command: 'snippets', args: 'list' })
  expect(listed.text).toContain('`;;hi`')
  expect(listed.text).toContain('`;;deploy`')
  expect(listed.text).toContain('~/.claude/snippets.json')

  await $.command.run({ command: 'snippets', args: 'remove ;;hi' })
  expect(JSON.parse(disk[YOURS])[';;hi']).toBeUndefined()

  await send($, ';;hi')
  expect(submitted.at(-1)).toBe(';;hi')
})

test('says so when the file has a mistake', async ($, on) => {
  await setup($, on, { [YOURS]: '{ ";;t": "oops", }' })
  const listed = await $.command.run({ command: 'snippets', args: 'list' })

  expect(listed.text).toContain('has a mistake')
})

const pane = { title: 'Snippets', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: {}, view: {} } as any
const mountWindow = ($: any, surface: 'desktop' | 'terminal' = 'desktop') =>
  $.ui.mount({ plugin: 'text-expander', surface, component: 'Pane', requestId: 'snippets', props: pane })

test('/snippets opens a window of short and long forms', async ($, on) => {
  const { opened } = await setup($, on)
  await $.command.run({ command: 'snippets', args: '' })
  expect(opened).toEqual(['snippets'])

  const ui = await mountWindow($)
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('Short form')
  expect(drawn).toContain('Turns into')
  expect(drawn).toContain(';;t')
  expect(drawn).toContain('Run the tests and fix anything that fails.')

  await $.command.run({ command: 'snippets', args: '' })
  expect(opened).toEqual([])
})

for (const surface of ['desktop', 'terminal'] as const) {
  test(`adds and deletes rows from the window on the ${surface}`, async ($, on) => {
    const { disk, submitted } = await setup($, on)
    const ui = await mountWindow($, surface)

    await ui.input({ key: 'trigger-0', text: ';;hi', kind: 'change' })
    await ui.input({ key: 'text-0', text: 'Hello Claude, here is what I need:' })
    expect(JSON.parse(disk[YOURS])[';;hi']).toBe('Hello Claude, here is what I need:')
    // The add row starts over, empty.
    expect(JSON.stringify(await ui.drawn())).toContain('"key":"trigger-1"')

    await send($, ';;hi')
    expect(submitted.at(-1)).toBe('Hello Claude, here is what I need:')

    await ui.press({ key: 'delete:yours:;;hi' })
    expect(JSON.parse(disk[YOURS])[';;hi']).toBeUndefined()
    expect(JSON.stringify(await ui.drawn())).not.toContain('Hello Claude')
  })
}

test('the Add button says what is missing', async ($, on) => {
  const { toasts } = await setup($, on)
  const ui = await mountWindow($)
  await ui.input({ key: 'trigger-0', text: ';;x', kind: 'change' })
  await ui.press({ key: 'add' })

  expect(toasts.at(-1)).toBe('Type what ;;x should turn into.')
})
