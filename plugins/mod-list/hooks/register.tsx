import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ModRow } from '../types'

const mods = atom({ plugin: 'mod-list', key: 'mods' } as const, [])
const problem = atom({ plugin: 'mod-list', key: 'problem' } as const, '')

const PANE = 'mod-list'
const TITLE = 'Mods'
const HOME_MARKETPLACE = 'claude-mods'

// The claude-mods mods in words that fit a table cell, and how each one is switched in a session.
// In this order in the table; anything from elsewhere follows, by name.
const KNOWN: Record<string, { short: string; toggle: string }> = {
  'imessage-chat': { short: 'Chat drawn as iMessage bubbles', toggle: '`/imessage off` · `/imessage on`' },
  'session-hud': { short: 'Usage card above the message box', toggle: '`/hud off` · `/hud on`' },
  'typing-bubble': { short: 'iMessage typing dots while Claude works', toggle: '`/typing off` · `/typing on`' },
  'done-chime': { short: 'Sounds on send and on reply', toggle: '`/chime off` · `/chime on`' },
  'turn-summary': { short: 'Time, tools and lines changed per reply', toggle: '`/summary off` · `/summary on`' },
  'break-reminder': { short: 'Break countdown and nudges', toggle: '`/break off` · `/break on`' },
  'agent-threads': { short: 'Pane of the main thread and subagents', toggle: '`/threads` opens or closes it' },
  'files-changed': { short: 'Pane of files Claude changed', toggle: '`/files` opens or closes it' },
  'project-notes': { short: 'Checklist pane for each project', toggle: '`/notes` opens or closes it' },
  'text-expander': { short: '`;;t`-style snippets', toggle: 'No off switch: disable the plugin' },
  'screenshot-attach': { short: '`;;ss` attaches screenshots', toggle: 'No off switch: disable the plugin' },
  'mod-list': { short: 'This table', toggle: '`/mods` opens or closes it' },
}
const KNOWN_ORDER = Object.keys(KNOWN)

const FOOTER =
  'To turn a mod off everywhere, run `claude plugin disable <name>@<marketplace>` in a terminal and start a new session. `claude plugin enable` brings it back.'

// What installed_plugins.json records for one install of a plugin.
type InstallRecord = { scope?: string; installPath?: string; version?: string; projectPath?: string }

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const asInstalls = (value: unknown): Record<string, InstallRecord[]> => {
  const plugins = isObject(value) && isObject(value.plugins) ? value.plugins : {}

  return Object.fromEntries(
    Object.entries(plugins).map(([id, list]) => [id, Array.isArray(list) ? list.filter(isObject).map(one => one as InstallRecord) : []]),
  )
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

// The first part of a plugin's own description: up to its first colon, semicolon, dash or full stop.
const firstClause = (description: string) => {
  const clause = description.split(/[:;]|\s[—–-]\s|\.\s|\.$/)[0]?.trim() ?? ''

  return clause.length > 60 ? `${clause.slice(0, 59)}…` : clause
}

// A table cell keeps to one row: no pipes or line breaks of its own.
const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ')

// Where Claude Code keeps its files: CLAUDE_CONFIG_DIR when set, else ~/.claude.
const configDir = async ($: EngineInterface) => (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${(await $.env.get('HOME')) ?? ''}/.claude`

const readJson = async ($: EngineInterface, path: string): Promise<unknown> => JSON.parse(String(await $.fs.read(path)))

type Manifest = { name: string; description: string; version?: string }

const readManifest = async ($: EngineInterface, folder: string): Promise<Manifest | undefined> => {
  try {
    const manifest = await readJson($, `${folder}/.claude-plugin/plugin.json`)

    return isObject(manifest) && typeof manifest.name === 'string'
      ? {
          name: manifest.name,
          description: typeof manifest.description === 'string' ? manifest.description : '',
          version: typeof manifest.version === 'string' ? manifest.version : undefined,
        }
      : undefined
  } catch {
    return undefined
  }
}

// The folders this session loads mods from without installing them: its own dev-mods folder (where
// mods made in the session hot-reload) and CLAUDE_CODE_PLUGIN_DIRS. A --plugin-dir flag leaves no trace a mod can read.
const devFolders = async ($: EngineInterface, dir: string) => {
  const [sessionId, pluginDirs, home] = await Promise.all([$.session.id(), $.env.get('CLAUDE_CODE_PLUGIN_DIRS'), $.env.get('HOME')])
  const devMods = `${dir}/dev-mods/${sessionId}`
  let inDevMods: string[] = []

  try {
    inDevMods = (await $.fs.list(devMods)).filter(entry => entry.kind === 'dir').map(entry => `${devMods}/${entry.name}`)
  } catch {
    // No mods made in this session.
  }

  const fromEnv = (pluginDirs ?? '')
    .split(':')
    .map(path => path.trim().replace(/^~(?=\/|$)/, home ?? '~'))
    .filter(Boolean)

  return [...inDevMods, ...fromEnv]
}

// Every plugin installed for this project or for every project, with what the table says of it.
const load = async ($: EngineInterface) => {
  const [settings, commands, dir, root, cwd] = await Promise.all([
    $.settings.read(),
    $.command.list(),
    configDir($),
    $.session.root(),
    $.session.cwd(),
  ])
  const enabled = isObject(settings.enabledPlugins) ? settings.enabledPlugins : {}
  let installs: Record<string, InstallRecord[]> = {}
  let note = ''

  try {
    installs = asInstalls(await readJson($, `${dir}/plugins/installed_plugins.json`))
  } catch {
    note = "Couldn't read Claude Code's list of installed plugins, so only the enabled ones from your settings are listed."
  }

  // An install for another project isn't one here.
  const applies = (record: InstallRecord) =>
    record.scope === undefined || record.scope === 'user' || record.scope === 'managed' || record.projectPath === root || record.projectPath === cwd
  const ids = new Set([
    ...Object.entries(installs)
      .filter(([, records]) => records.some(applies))
      .map(([id]) => id),
    ...(note === '' ? [] : Object.keys(enabled)),
  ])

  const rows = await Promise.all(
    [...ids].map(async (id): Promise<ModRow> => {
      const at = id.lastIndexOf('@')
      const name = at > 0 ? id.slice(0, at) : id
      const marketplace = at > 0 ? id.slice(at + 1) : ''
      const record = installs[id]?.find(applies)
      let description = ''

      if (record?.installPath !== undefined) {
        try {
          const manifest = await readJson($, `${record.installPath}/.claude-plugin/plugin.json`)
          description = isObject(manifest) && typeof manifest.description === 'string' ? manifest.description : ''
        } catch {
          // A plugin without a readable manifest still gets its row.
        }
      }

      const known = marketplace === HOME_MARKETPLACE ? KNOWN[name] : undefined
      const own = commands.filter(command => command.plugin === name).map(command => `\`/${command.name}\``)

      return {
        id,
        name,
        version: record?.version,
        isEnabled: enabled[id] !== false,
        short: known?.short ?? firstClause(description),
        toggle: known?.toggle ?? (own.length > 0 ? own.join(' · ') : 'No slash command: disable the plugin'),
        source: 'installed',
        hasDevCopy: false,
      }
    }),
  )

  // Mods loaded from a folder: a row of their own, or a mark on the installed mod they copy.
  const devManifests = (await Promise.all((await devFolders($, dir)).map(folder => readManifest($, folder)))).filter(
    (manifest): manifest is Manifest => manifest !== undefined,
  )

  for (const manifest of devManifests) {
    const installed = rows.find(row => row.name === manifest.name)

    if (installed !== undefined) {
      installed.hasDevCopy = true
      continue
    }

    if (rows.some(row => row.id === manifest.name)) {
      continue
    }

    const known = KNOWN[manifest.name]
    const own = commands.filter(command => command.plugin === manifest.name).map(command => `\`/${command.name}\``)
    rows.push({
      id: manifest.name,
      name: manifest.name,
      version: manifest.version,
      isEnabled: true,
      short: known?.short ?? firstClause(manifest.description),
      toggle: known?.toggle ?? (own.length > 0 ? own.join(' · ') : 'No slash command'),
      source: 'dev',
      hasDevCopy: false,
    })
  }

  const rank = (row: ModRow) => {
    const index = row.id.endsWith(`@${HOME_MARKETPLACE}`) || row.source === 'dev' ? KNOWN_ORDER.indexOf(row.name) : -1

    return index === -1 ? KNOWN_ORDER.length : index
  }
  rows.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))

  await update($, mods, () => rows)
  await update($, problem, () => note)

  return rows
}

const isOpen = async ($: EngineInterface) => (await $.ui.panes()).some(pane => pane.id === PANE)

// One row of the table; a disabled mod says so, and how to bring it back.
const tableRow = (row: ModRow) => {
  const tag = row.source === 'dev' ? ' *(dev)*' : row.hasDevCopy ? ' *(dev copy loaded)*' : ''

  return row.isEnabled
    ? `| \`${cell(row.name)}\`${tag} | ${cell(row.short)} | ${cell(row.toggle)} |`
    : `| \`${cell(row.name)}\` *(disabled)*${tag} | ${cell(row.short)} | \`claude plugin enable ${cell(row.id)}\` |`
}

const DEV_NOTE = '*(dev)* mods load from a folder this session watches (mods made in it, or `CLAUDE_CODE_PLUGIN_DIRS`) and aren\'t installed.'

const summary = (rows: readonly ModRow[]) => {
  const installed = rows.filter(row => row.source === 'installed')
  const dev = rows.length - installed.length

  return [
    `${plural(installed.length, 'mod')} installed`,
    `${installed.filter(row => row.isEnabled).length} enabled`,
    dev === 0 ? '' : `${dev} from a dev folder`,
  ]
    .filter(Boolean)
    .join(' · ')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'mods',
      description: 'Show or hide a table of your installed mods and how to switch each one off or on',
      argumentHint: '[open|close]',
      immediate: true,
    })

    return started
  })

  on('command.run', { command: 'mods' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()

    if (!['', 'open', 'on', 'close', 'off'].includes(arg)) {
      return { text: 'Usage: /mods to show or hide the table, /mods open, /mods close.' }
    }

    const isShown = await isOpen($)
    const wantsOpen = arg === 'open' || arg === 'on' ? true : arg === 'close' || arg === 'off' ? false : !isShown

    if (!wantsOpen) {
      if (isShown) {
        await $.ui.close({ id: PANE })
      }

      return { text: 'Mods pane closed. /mods opens it again.' }
    }

    // Read afresh each time it opens: a mod installed or disabled since shows as it is now.
    const rows = await load($)
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: `Mods pane open: ${summary(rows).replace(/ · /g, ', ')}.` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Markdown, Text } = $.ui.resolve(e)
    const [rows, note] = await Promise.all([read($, mods), read($, problem)])
    const table = ['| Mod | What it does | Turn off / on |', '| --- | --- | --- |', ...rows.map(tableRow)].join('\n')

    return (
      <Box flexDirection="column" paddingX={1} gap={1}>
        <Text color="subtle">{summary(rows)}</Text>
        {rows.length === 0 ? (
          <Text key="empty" dimColor>
            No mods installed.
          </Text>
        ) : (
          <Markdown key="table" text={table.slice(0, 10_000)} />
        )}
        <Markdown key="footer" dimColor text={rows.some(row => row.source === 'dev') ? `${FOOTER}\n\n${DEV_NOTE}` : FOOTER} />
        {note === '' ? null : (
          <Text key="note" color="subtle" wrap="wrap">
            {note}
          </Text>
        )}
      </Box>
    )
  })
}
