import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Notes } from '../types'

const notes = atom({ plugin: 'project-notes', key: 'notes' } as const, null)
const draft = atom({ plugin: 'project-notes', key: 'draft' } as const, 0)

const PANE = 'notes'
// While the pane is open, edits made in another editor show up within this long.
const SYNC_MS = 5_000

const ITEM = /^\s*[-*] \[( |x|X)\] (.*)$/
const BULLET = /^\s*[-*] (.*)$/

type Line = { index: number; text: string; isItem: boolean; isDone: boolean; isHeading: boolean }

const parse = (lines: readonly string[]): Line[] =>
  lines
    .map((line, index) => {
      const item = ITEM.exec(line)

      if (item !== null) {
        return { index, text: item[2] ?? '', isItem: true, isDone: item[1] !== ' ', isHeading: false }
      }

      const bullet = BULLET.exec(line)

      if (bullet !== null) {
        return { index, text: bullet[1] ?? '', isItem: true, isDone: false, isHeading: false }
      }

      return { index, text: line.replace(/^#+\s*/, ''), isItem: false, isDone: false, isHeading: /^#/.test(line) }
    })
    .filter(line => line.text.trim() !== '')

// One file per project, named after its folder the way ~/.claude/projects names them.
const where = async ($: EngineInterface) => {
  const [home, root] = await Promise.all([$.env.get('HOME'), $.session.root()])

  return {
    path: `${home ?? ''}/.claude/notes/${root.replace(/[^A-Za-z0-9]/g, '-')}.md`,
    project: root.split('/').filter(Boolean).pop() ?? root,
    home: home ?? '',
  }
}

const tidy = (path: string, home: string) => (home !== '' && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path)

const load = async ($: EngineInterface) => {
  const { path, project } = await where($)
  const text = (await $.fs.exists(path)) ? await $.fs.read(path) : ''
  const lines = text.replace(/\n+$/, '').split('\n').filter((line, i, all) => !(all.length === 1 && line === ''))
  const current = await read($, notes)

  if (current === null || current.path !== path || current.lines.join('\n') !== lines.join('\n')) {
    await update($, notes, () => ({ path, project, lines }))
  }

  return { path, project, lines }
}

const save = async ($: EngineInterface, change: (lines: string[]) => string[]) => {
  const { path, project, lines } = await load($)
  const changed = change(lines)
  await $.fs.write(path, changed.length === 0 ? '' : `${changed.join('\n')}\n`)
  await update($, notes, () => ({ path, project, lines: changed }))
}

const addNote = ($: EngineInterface, text: string) => save($, lines => [...lines, `- [ ] ${text.replace(/\s*\n\s*/g, ' ').trim()}`])

const toggle = ($: EngineInterface, index: number) =>
  save($, lines =>
    lines.map((line, i) => {
      if (i !== index) {
        return line
      }

      const item = ITEM.exec(line)

      if (item !== null) {
        return line.replace(/\[( |x|X)\]/, item[1] === ' ' ? '[x]' : '[ ]')
      }

      // A plain bullet becomes a ticked box.
      return line.replace(/^(\s*)[-*] /, '$1- [x] ')
    }),
  )

const removeNote = ($: EngineInterface, index: number) => save($, lines => lines.filter((_, i) => i !== index))

const clearDone = ($: EngineInterface) => save($, lines => lines.filter(line => !/^\s*[-*] \[(x|X)\] /.test(line)))

const openInEditor = async ($: EngineInterface) => {
  const { path, home } = await where($)

  if (!(await $.fs.exists(path))) {
    await $.fs.write(path, '')
  }

  try {
    await $.process.run(['/usr/bin/open', '-t', path], { timeoutMs: 10_000 })

    return `Opened \`${tidy(path, home)}\`. The pane picks up your changes within a few seconds.`
  } catch {
    return `Your notes are in \`${tidy(path, home)}\`.`
  }
}

const isOpen = async ($: EngineInterface) => (await $.ui.panes()).some(pane => pane.id === PANE)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'notes',
      description: "Show or hide this project's notes",
      argumentHint: '[edit|clear done]',
      immediate: true,
    })
    await $.command.register({
      name: 'note',
      description: "Add a note to this project's notes",
      argumentHint: '<what to remember>',
      immediate: true,
    })
    await load($).catch(() => undefined)
    $.clock.every(SYNC_MS, () => {
      void isOpen($)
        .then(open => (open ? load($) : undefined))
        .catch(() => {})
    })

    return started
  })

  on('command.run', { command: 'notes' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()

    if (arg === 'edit' || arg === 'open') {
      return { text: await openInEditor($) }
    }

    if (arg === 'clear done' || arg === 'clear') {
      await clearDone($)

      return { text: 'Cleared the ticked notes.' }
    }

    if (await isOpen($)) {
      await $.ui.close({ id: PANE })

      return { text: 'Notes closed. `/notes` opens them again.' }
    }

    const { project, lines } = await load($)
    await $.ui.open({ id: PANE, title: `Notes · ${project}` })
    const count = parse(lines).filter(line => line.isItem && !line.isDone).length

    return { text: count === 0 ? `Notes for ${project} open.` : `Notes for ${project} open: ${count} to do.` }
  })

  on('command.run', { command: 'note' }, async ($, e) => {
    const text = e.args.trim()

    if (text === '') {
      return { text: 'Add what to remember: `/note check the logo on dark mode`' }
    }

    await addNote($, text)
    const { project } = await where($)

    return { text: `Added to ${project}'s notes. \`/notes\` shows them all.` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const current = await read($, notes)
    const count = await read($, draft)
    const lines = parse(current?.lines ?? [])
    const items = lines.filter(line => line.isItem)
    const doneCount = items.filter(line => line.isDone).length
    const { Box, Button, Text } = $.ui.resolve(e)

    const onAdd = async (value: string) => {
      if (value.trim() !== '') {
        await addNote($, value)
        await update($, draft, n => n + 1)
      }
    }

    // The mobile app has no text field yet; there, notes are added with /note.
    let field = null

    if (e.surface !== 'mobile') {
      const { Input } = $.ui.resolve(e)
      field = <Input key={`add-${count}`} placeholder="Add a note…" submitLabel="add" onSubmit={value => void onAdd(value)} />
    }

    return (
      <Box flexDirection="column" paddingX={1}>
        {field}
        <Box flexDirection="column" marginY={1}>
          {lines.length === 0 ? (
            <Text dimColor wrap="wrap">
              {`No notes yet for ${current?.project ?? 'this project'}. Type one above, or send /note followed by what to remember.`}
            </Text>
          ) : (
            lines.map(line =>
              line.isItem ? (
                <Box key={`row:${line.index}`} flexDirection="row" gap={1}>
                  <Button key={`toggle:${line.index}`} label={line.isDone ? '☑' : '☐'} plain onPress={() => void toggle($, line.index)} />
                  <Box flexGrow={1} flexShrink={1}>
                    <Text wrap="wrap" strikethrough={line.isDone} dimColor={line.isDone}>
                      {line.text}
                    </Text>
                  </Box>
                  <Button key={`delete:${line.index}`} label="✕" plain dimColor onPress={() => void removeNote($, line.index)} />
                </Box>
              ) : (
                <Text key={`text:${line.index}`} bold={line.isHeading} dimColor={!line.isHeading} wrap="wrap">
                  {line.text}
                </Text>
              ),
            )
          )}
        </Box>
        <Box flexDirection="row" gap={1}>
          <Button key="edit" label="Open file" onPress={() => void openInEditor($)} />
          {doneCount === 0 ? null : <Button key="clear" label={`Clear ${doneCount} done`} onPress={() => void clearDone($)} />}
        </Box>
      </Box>
    )
  })
}
