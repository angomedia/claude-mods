import { expect, mock, test } from 'claude-code/testing'

const pane = { title: 'Mods', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: {}, view: {} } as any

const INSTALLED = JSON.stringify({
  version: 2,
  plugins: {
    'text-expander@claude-mods': [{ scope: 'user', installPath: '/cache/text-expander/0.2.1', version: '0.2.1' }],
    'session-hud@claude-mods': [{ scope: 'user', installPath: '/cache/session-hud/0.2.2', version: '0.2.2' }],
    'weather@other-market': [{ scope: 'user', installPath: '/cache/weather/1.0.0', version: '1.0.0' }],
    'elsewhere@claude-mods': [{ scope: 'project', projectPath: '/other/project', installPath: '/cache/elsewhere/0.1.0' }],
  },
})

const MANIFESTS: Record<string, string> = {
  '/cache/weather/1.0.0/.claude-plugin/plugin.json': JSON.stringify({ name: 'weather', description: 'Shows the weather | in a pane: a forecast for the week' }),
  '/cache/session-hud/0.2.2/.claude-plugin/plugin.json': JSON.stringify({ name: 'session-hud', description: 'A long description the table does not use' }),
}

// This session's dev-mods folder: a mod made in it, a dev copy of an installed one, and a stray file.
const DEV_MODS = '/Users/someone/.claude/dev-mods/sess-1'
const DEV_MANIFESTS: Record<string, string> = {
  [`${DEV_MODS}/mod-list/.claude-plugin/plugin.json`]: JSON.stringify({ name: 'mod-list', description: 'A table of mods', version: '0.1.0' }),
  [`${DEV_MODS}/session-hud/.claude-plugin/plugin.json`]: JSON.stringify({ name: 'session-hud', description: 'A dev copy' }),
  ['/work/plugins/radar/.claude-plugin/plugin.json']: JSON.stringify({ name: 'radar', description: 'Rain radar: a map that refreshes' }),
}

const setup = async ($: any, on: any, options: { canReadInstalled?: boolean; hasDevMods?: boolean; pluginDirs?: string } = {}) => {
  const opened: string[] = []
  mock.env(on, { HOME: '/Users/someone', ...(options.pluginDirs === undefined ? {} : { CLAUDE_CODE_PLUGIN_DIRS: options.pluginDirs }) })
  on('session.id', () => ({ value: 'sess-1' }) as any)
  on('fs.list', (_$: unknown, e: { path?: string }) => {
    if (e.path === DEV_MODS && options.hasDevMods === true) {
      return {
        value: [
          { name: 'mod-list', kind: 'dir', size: 0, mtimeMs: 0, isLink: false },
          { name: 'session-hud', kind: 'dir', size: 0, mtimeMs: 0, isLink: false },
          { name: 'notes.txt', kind: 'file', size: 3, mtimeMs: 0, isLink: false },
        ],
      } as any
    }
    throw new Error(`ENOENT: ${e.path}`)
  })
  on('settings.read', () => ({
    value: { enabledPlugins: { 'session-hud@claude-mods': true, 'text-expander@claude-mods': false, 'weather@other-market': true } },
  }) as any)
  on('command.list', () => ({
    value: [
      { name: 'hud', description: 'Show or hide the card', source: 'plugin', plugin: 'session-hud' },
      { name: 'forecast', description: 'Show the forecast', source: 'plugin', plugin: 'weather' },
      { name: 'clear', description: 'Clear the conversation', source: 'builtin' },
    ],
  }) as any)
  on('session.root', () => ({ value: '/work/app' }) as any)
  on('session.cwd', () => ({ value: '/work/app' }) as any)
  on('fs.read', (_$: unknown, e: { path: string }) => {
    if (e.path === '/Users/someone/.claude/plugins/installed_plugins.json' && options.canReadInstalled !== false) {
      return { value: INSTALLED } as any
    }
    const manifest = MANIFESTS[e.path] ?? DEV_MANIFESTS[e.path]
    if (manifest === undefined) {
      throw new Error(`ENOENT: ${e.path}`)
    }
    return { value: manifest } as any
  })
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
  on('ui.render', () => ({ type: 'engine', ref: 1 }) as const)
  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })

  return { opened }
}

const draw = async ($: any, surface: 'desktop' | 'terminal' = 'desktop') => {
  const ui = await $.ui.mount({ plugin: 'mod-list', surface, component: 'Pane', requestId: 'mod-list', props: pane })
  const drawn = JSON.stringify(await ui.drawn())
  await ui.unmount()
  return drawn
}

for (const surface of ['desktop', 'terminal'] as const) {
  test(`lists each installed mod with what it does and how to switch it, on the ${surface}`, async ($, on) => {
    await setup($, on)
    const { text } = await $.command.run({ command: 'mods', args: '' } as any)
    const drawn = await draw($, surface)

    expect(text).toBe('Mods pane open: 3 mods installed, 2 enabled.')
    expect(drawn).toContain('3 mods installed · 2 enabled')
    expect(drawn).toContain('| Mod | What it does | Turn off / on |')
    // A claude-mods mod: its short description and its own switch.
    expect(drawn).toContain('Usage card above the message box')
    expect(drawn).toContain('`/hud off` · `/hud on`')
    // A disabled one says so, and how to bring it back.
    expect(drawn).toContain('`text-expander` *(disabled)*')
    expect(drawn).toContain('`claude plugin enable text-expander@claude-mods`')
    // One from elsewhere: the start of its own description, and its slash commands.
    expect(drawn).toContain('Shows the weather')
    expect(drawn).not.toContain('a forecast for the week')
    expect(drawn).toContain('`/forecast`')
    // An install for another project isn't listed here.
    expect(drawn).not.toContain('elsewhere')
    expect(drawn).toContain('claude plugin disable')
  })
}

test('claude-mods come first in their usual order, then the rest by name', async ($, on) => {
  await setup($, on)
  await $.command.run({ command: 'mods', args: '' } as any)
  const drawn = await draw($)

  expect(drawn.indexOf('session-hud')).toBeLessThan(drawn.indexOf('text-expander'))
  expect(drawn.indexOf('text-expander')).toBeLessThan(drawn.indexOf('weather'))
})

test('/mods opens and closes the pane', async ($, on) => {
  const { opened } = await setup($, on)
  await $.command.run({ command: 'mods', args: '' } as any)
  expect(opened).toEqual(['mod-list'])

  await $.command.run({ command: 'mods', args: '' } as any)
  expect(opened).toEqual([])
})

test("without Claude Code's list of installed plugins, it lists the enabled ones from settings and says so", async ($, on) => {
  await setup($, on, { canReadInstalled: false })
  await $.command.run({ command: 'mods', args: 'open' } as any)
  const drawn = await draw($)

  expect(drawn).toContain("Couldn't read Claude Code's list of installed plugins")
  expect(drawn).toContain('session-hud')
  expect(drawn).toContain('weather')
})

test('mods loaded from dev folders are listed too, marked dev', async ($, on) => {
  await setup($, on, { hasDevMods: true, pluginDirs: '/work/plugins/radar' })
  const { text } = await $.command.run({ command: 'mods', args: '' } as any)
  const drawn = await draw($)

  expect(text).toBe('Mods pane open: 3 mods installed, 2 enabled, 2 from a dev folder.')
  // Made in this session and not installed: a row of its own, with what the table knows of it.
  expect(drawn).toContain('`mod-list` *(dev)*')
  expect(drawn).toContain('This table')
  // From CLAUDE_CODE_PLUGIN_DIRS: the start of its own description.
  expect(drawn).toContain('`radar` *(dev)*')
  expect(drawn).toContain('Rain radar')
  // A dev copy of an installed mod marks that mod's row instead of adding one.
  expect(drawn).toContain('`session-hud` *(dev copy loaded)*')
  expect(drawn.split('session-hud').length - 1).toBe(1)
  expect(drawn).toContain("aren't installed")
})

test('with no dev folders, nothing is marked dev', async ($, on) => {
  await setup($, on)
  await $.command.run({ command: 'mods', args: '' } as any)
  const drawn = await draw($)

  expect(drawn).not.toContain('(dev')
  expect(drawn).not.toContain("aren't installed")
})
