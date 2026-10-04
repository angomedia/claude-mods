import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { SnippetFileView, Where } from '../types'

type Snippets = Record<string, string>
type SnippetFile = { where: Where; path: string; snippets: Snippets; error?: string }

const files = atom({ plugin: 'text-expander', key: 'files' } as const, [])
const form = atom({ plugin: 'text-expander', key: 'form' } as const, 0)

const PANE = 'snippets'
// While the window is open, edits made to the files elsewhere show up within this long.
const SYNC_MS = 5_000
// The short-form column, in character cells.
const TRIGGER_COLUMNS = 10

// Written the first time the mod runs, so there's something to try and a file to copy from.
const STARTERS: Snippets = {
  ';;t': 'Run the tests and fix anything that fails. Tell me what you changed.',
  ';;e': "Explain this in plain language, as if I'm new to it. Keep it short.",
  ';;r': 'Review what you just changed for bugs and edge cases before we move on.',
  ';;s': "Summarize what you did, what you checked, and what's left, in a few bullets.",
  ';;p': 'Make a plan first and wait for my OK before changing any files.',
  ';;c': 'Commit these changes with a clear message.',
}

// Prompts the person sent; notifications and other agents' messages are left as they are.
const OWN_PROMPTS = new Set(['composer', 'bridge', 'sdk', 'scheduled-trigger'])

const paths = async ($: EngineInterface) => {
  const home = (await $.env.get('HOME')) ?? ''

  return { yours: `${home}/.claude/snippets.json`, project: `${await $.session.root()}/.claude/snippets.json`, home }
}

const tidy = (path: string, home: string) => (home !== '' && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path)

const readFile = async ($: EngineInterface, where: Where, path: string): Promise<SnippetFile> => {
  if (!(await $.fs.exists(path))) {
    return { where, path, snippets: {} }
  }

  try {
    const parsed: unknown = JSON.parse(await $.fs.read(path))

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { where, path, snippets: {}, error: 'it should be one object of "trigger": "text" pairs' }
    }

    const snippets = Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && /^\S+$/.test(entry[0])),
    )

    return { where, path, snippets }
  } catch (error) {
    return { where, path, snippets: {}, error: error instanceof Error ? error.message : String(error) }
  }
}

const readAll = async ($: EngineInterface) => {
  const where = await paths($)

  return { ...where, files: await Promise.all([readFile($, 'yours', where.yours), readFile($, 'project', where.project)]) }
}

const writeFile = ($: EngineInterface, path: string, snippets: Snippets) => $.fs.write(path, `${JSON.stringify(snippets, null, 2)}\n`)

// Reads both files again and redraws the window if anything changed.
const refresh = async ($: EngineInterface) => {
  const { files: found, home } = await readAll($)
  const views: SnippetFileView[] = found.map(file => ({ ...file, shown: tidy(file.path, home) }))

  if (JSON.stringify(await read($, files)) !== JSON.stringify(views)) {
    await update($, files, () => views)
  }

  return views
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// A trigger expands where it stands as a word of its own: after a space or the start, before a
// space, the end, or punctuation.
const expand = (text: string, snippets: Snippets) => {
  const triggers = Object.keys(snippets).sort((a, b) => b.length - a.length)
  const used: string[] = []

  if (triggers.length === 0) {
    return { text, used }
  }

  const pattern = new RegExp(`(^|\\s)(${triggers.map(escapeRegExp).join('|')})(?=$|\\s|[.,!?:)\\]])`, 'g')
  const expanded = text.replace(pattern, (_match, lead: string, trigger: string) => {
    used.push(trigger)

    return `${lead}${snippets[trigger]}`
  })

  return { text: expanded, used }
}

const cell = (text: string, max = 70) => {
  const flat = text.replace(/\s+/g, ' ').replace(/\|/g, '\\|').replace(/`/g, "'")

  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

const table = (snippets: Snippets) =>
  ['| Type | To send |', '| --- | --- |', ...Object.entries(snippets).map(([trigger, text]) => `| \`${trigger}\` | ${cell(text)} |`)].join('\n')

const HELP = [
  '**The window:** `/snippets` opens a table of your snippets, where you can add and delete them.',
  '**Add one** for every project: `/snippets add ;;x what it expands to`',
  '**Add one** for this project only: `/snippets add-here ;;x what it expands to`',
  '**Remove one:** `/snippets remove ;;x`',
  '**Edit the file:** `/snippets edit` (yours) or `/snippets edit here` (this project)',
].join('\n')

const list = async ($: EngineInterface) => {
  const { files: all, home } = await readAll($)
  const sections = all.map(file => {
    const title =
      file.where === 'yours'
        ? `**Your snippets**, in every project · \`${tidy(file.path, home)}\``
        : `**This project's snippets** · \`${tidy(file.path, home)}\` (commit it to share them)`

    if (file.error !== undefined) {
      return `${title}\n\nThis file has a mistake, so none of its snippets work: ${file.error}`
    }

    return Object.keys(file.snippets).length === 0 ? `${title}\n\nNone yet.` : `${title}\n\n${table(file.snippets)}`
  })

  return [...sections, HELP].join('\n\n')
}

// Opens the file in the Mac's default text editor, creating it first if needed.
const edit = async ($: EngineInterface, where: Where) => {
  const all = await paths($)
  const path = where === 'yours' ? all.yours : all.project

  if (!(await $.fs.exists(path))) {
    await writeFile($, path, {})
  }

  try {
    await $.process.run(['/usr/bin/open', '-t', path], { timeoutMs: 10_000 })

    return `Opened \`${tidy(path, all.home)}\`. Changes work on your next message.`
  } catch {
    return `Edit \`${tidy(path, all.home)}\` in any text editor. Changes work on your next message.`
  }
}

// Adds or replaces one snippet; answers what happened, in a sentence.
const addSnippet = async ($: EngineInterface, where: Where, trigger: string, text: string) => {
  if (trigger === '' || /\s/.test(trigger)) {
    return { isAdded: false, message: 'The short form is one word with no spaces, like ;;hi' }
  }

  if (text.trim() === '') {
    return { isAdded: false, message: `Type what ${trigger} should turn into.` }
  }

  const all = await paths($)
  const file = await readFile($, where, where === 'yours' ? all.yours : all.project)

  if (file.error !== undefined) {
    return { isAdded: false, message: `${tidy(file.path, all.home)} has a mistake, so I left it alone: ${file.error}` }
  }

  const isUpdate = trigger in file.snippets
  await writeFile($, file.path, { ...file.snippets, [trigger]: text.trim() })
  await refresh($)

  return { isAdded: true, message: `${isUpdate ? 'Updated' : 'Added'} ${trigger}${where === 'project' ? ' for this project' : ''}.` }
}

const removeSnippet = async ($: EngineInterface, trigger: string, only?: Where) => {
  const { files: all } = await readAll($)
  const holding = all.filter(file => file.error === undefined && trigger in file.snippets && (only === undefined || file.where === only))

  for (const file of holding) {
    const { [trigger]: _removed, ...rest } = file.snippets
    await writeFile($, file.path, rest)
  }

  await refresh($)

  return holding.length > 0
}

const isOpen = async ($: EngineInterface) => (await $.ui.panes()).some(pane => pane.id === PANE)

const openWindow = async ($: EngineInterface) => {
  const views = await refresh($)
  const count = views.reduce((sum, file) => sum + Object.keys(file.snippets).length, 0)
  await $.ui.open({ id: PANE, title: 'Snippets', focus: true, closeOnEscape: true, rows: count + 10, columns: 90 })

  return count
}

// The add row is one field: the short form, a space, then what it turns into (";;hi How are you?").
// One field, because the desktop draws a button beside every field.
const addFromField = async ($: EngineInterface, value: string) => {
  const typed = value.trim()
  const trigger = typed.split(/\s+/)[0] ?? ''
  // "=" or ":" between the two is fine too: ";;hi = How are you?"
  const text = typed.slice(trigger.length).replace(/^\s*[=:→]\s*/, '').trim()

  if (trigger === '') {
    $.ui.toast('Type the short form, a space, then what it turns into: ;;hi How are you?')

    return
  }

  const result = await addSnippet($, 'yours', trigger, text)
  $.ui.toast(result.message)

  if (result.isAdded) {
    await update($, form, n => n + 1)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'snippets',
      description: 'Open your snippets: short forms like ;;t that turn into whole prompts when you send them',
      argumentHint: '[list|add|add-here|remove|edit]',
      immediate: true,
    })

    // Starter snippets, once: a file you delete stays deleted.
    const { yours } = await paths($)

    if ((await $.store.get('seeded')) !== true) {
      if (!(await $.fs.exists(yours))) {
        await writeFile($, yours, STARTERS)
      }

      await $.store.set('seeded', true)
    }

    await refresh($).catch(() => undefined)
    $.clock.every(SYNC_MS, () => {
      void isOpen($)
        .then(open => (open ? refresh($) : undefined))
        .catch(() => {})
    })

    return started
  })

  on('prompt.submit', async ($, e, next) => {
    if (!OWN_PROMPTS.has(e.origin.kind) || !/\S/.test(e.text)) {
      return next(e)
    }

    const { files: all } = await readAll($)
    // This project's snippets win over yours.
    const snippets = { ...all[0].snippets, ...all[1].snippets }
    const { text, used } = expand(e.text, snippets)

    if (used.length === 0) {
      return next(e)
    }

    $.ui.toast(`Expanded ${[...new Set(used)].join(', ')}`)

    return next({ ...e, text })
  })

  on('command.run', { command: 'snippets' }, async ($, e) => {
    const args = e.args.trim()
    const [word = '', trigger = ''] = args.split(/\s+/)
    const action = word.toLowerCase()
    const text = args.slice(word.length).trim().slice(trigger.length).trim()

    if (action === '' || action === 'open') {
      if (await isOpen($)) {
        await $.ui.close({ id: PANE })

        return { text: 'Snippets closed. `/snippets` opens them again.' }
      }

      const count = await openWindow($)

      return { text: `Snippets open: ${count} snippet${count === 1 ? '' : 's'}. Add a row at the bottom, or ✕ to delete one.` }
    }

    if (action === 'list') {
      return { text: await list($) }
    }

    if (action === 'edit') {
      return { text: await edit($, trigger.toLowerCase() === 'here' ? 'project' : 'yours') }
    }

    if (action === 'add' || action === 'add-here') {
      if (trigger === '' || text === '') {
        return { text: `Give a trigger and what it expands to: \`/snippets ${action} ;;x your text\`` }
      }

      const result = await addSnippet($, action === 'add' ? 'yours' : 'project', trigger, text)

      return { text: result.isAdded ? `${result.message} Type it in a message to send: ${cell(text, 200)}` : result.message }
    }

    if (action === 'remove' || action === 'delete') {
      return { text: (await removeSnippet($, trigger)) ? `Removed \`${trigger}\`.` : `There's no \`${trigger}\` snippet. \`/snippets list\` lists them.` }
    }

    return { text: HELP }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const all = await read($, files)
    const formKey = await read($, form)
    const { Box, Button, Text } = $.ui.resolve(e)

    const header = (
      <Box key="header" flexDirection="row" gap={2}>
        <Box width={TRIGGER_COLUMNS} flexShrink={0}>
          <Text bold color="subtle">
            Short form
          </Text>
        </Box>
        <Box flexGrow={1} flexShrink={1} width={0}>
          <Text bold color="subtle">
            Turns into
          </Text>
        </Box>
      </Box>
    )

    const rows = (file: SnippetFileView) =>
      Object.entries(file.snippets).map(([trigger, text]) => (
        <Box key={`row:${file.where}:${trigger}`} flexDirection="row" gap={2}>
          <Box width={TRIGGER_COLUMNS} flexShrink={0}>
            <Text bold wrap="truncate-end">
              {trigger}
            </Text>
          </Box>
          <Box flexGrow={1} flexShrink={1} width={0}>
            <Text wrap="wrap">{text}</Text>
          </Box>
          <Button
            key={`delete:${file.where}:${trigger}`}
            label="✕"
            plain
            dimColor
            onPress={() =>
              void removeSnippet($, trigger, file.where).then(() => $.ui.toast(`Deleted ${trigger}`))
            }
          />
        </Box>
      ))

    const section = (file: SnippetFileView) => {
      const title = file.where === 'yours' ? `Yours, in every project · ${file.shown}` : `This project only · ${file.shown}`

      if (file.error !== undefined) {
        return (
          <Box key={`section:${file.where}`} flexDirection="column" marginBottom={1}>
            <Text dimColor>{title}</Text>
            <Text wrap="wrap">{`This file has a mistake, so none of its snippets work: ${file.error}`}</Text>
          </Box>
        )
      }

      if (Object.keys(file.snippets).length === 0) {
        return file.where === 'yours' ? (
          <Box key={`section:${file.where}`} flexDirection="column" marginBottom={1}>
            <Text dimColor>{title}</Text>
            <Text dimColor>None yet. Add one below.</Text>
          </Box>
        ) : null
      }

      return (
        <Box key={`section:${file.where}`} flexDirection="column" marginBottom={1}>
          <Text dimColor>{title}</Text>
          {rows(file)}
        </Box>
      )
    }

    // The mobile app has no text field yet; there, snippets are added with /snippets add.
    let addRow = null

    if (e.surface !== 'mobile') {
      const { Input } = $.ui.resolve(e)

      addRow = (
        <Box key="add" flexDirection="column">
          <Input
            key={`add-${formKey}`}
            placeholder=";;hi How are you doing?"
            submitLabel="Add"
            autoFocus
            onSubmit={value => void addFromField($, value)}
          />
          <Text dimColor wrap="wrap">
            The short form first, then a space, then what it turns into.
          </Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column" paddingX={1}>
        <Text dimColor wrap="wrap">
          Type a short form in a message; it turns into the long form when you send it.
        </Text>
        <Box flexDirection="column" marginY={1}>
          {header}
          {all.map(section)}
        </Box>
        {addRow}
        <Box flexDirection="row" gap={1} marginTop={1}>
          <Button key="edit" label="Open file" onPress={() => void edit($, 'yours').then(message => $.ui.toast(message.replace(/`/g, '')))} />
          <Button key="close" label="Done" role="dismiss" onPress={() => void $.ui.close({ id: PANE })} />
        </Box>
      </Box>
    )
  })
}
