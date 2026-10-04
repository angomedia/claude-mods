import { expect, mock, test } from 'claude-code/testing'

const HOME = '/Users/me'
const YOURS = `${HOME}/.claude/snippets.json`
const PROJECT = '/work/app/.claude/snippets.json'

// A small disk in memory, standing in for $.fs.
const setup = async ($: any, on: any, disk: Record<string, string> = {}) => {
  const toasts: string[] = []
  const submitted: string[] = []
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
  on('prompt.submit', (_$: unknown, e: { text: string }) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })

  return { disk, toasts, submitted }
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

  const listed = await $.command.run({ command: 'snippets', args: '' })
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
  const listed = await $.command.run({ command: 'snippets', args: '' })

  expect(listed.text).toContain('has a mistake')
})
