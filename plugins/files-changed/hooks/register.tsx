import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { FileChange } from '../types'

const files = atom({ plugin: 'files-changed', key: 'files' } as const, [])
const hasHinted = atom({ plugin: 'files-changed', key: 'hasHinted' } as const, false)

const PANE = 'files-changed'
const TITLE = 'Files changed'
const FILE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])
// iOS system green and red.
const ADDED = '#34C759'
const REMOVED = '#FF453A'

type Hunk = { lines: readonly string[] }
type FileResult = {
  filePath?: string
  notebook_path?: string
  type?: 'create' | 'update'
  content?: string
  structuredPatch?: readonly Hunk[]
  old_source?: string
  new_source?: string
  staged?: boolean
}

const lineCount = (text: string | undefined) => (text === undefined || text === '' ? 0 : text.replace(/\n$/, '').split('\n').length)

// The lines one file tool call added and removed, from its own patch.
const changeOf = (tool: string, result: FileResult) => {
  if (result.staged === true) {
    return undefined
  }

  if (tool === 'NotebookEdit') {
    return result.notebook_path === undefined
      ? undefined
      : { path: result.notebook_path, added: lineCount(result.new_source), removed: lineCount(result.old_source), isNew: false }
  }

  if (result.filePath === undefined) {
    return undefined
  }

  let added = 0
  let removed = 0

  for (const hunk of result.structuredPatch ?? []) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) {
        added++
      } else if (line.startsWith('-')) {
        removed++
      }
    }
  }

  const isNew = tool === 'Write' && result.type === 'create'

  // A new file has no patch: all of it is new.
  return { path: result.filePath, added: isNew && added === 0 ? lineCount(result.content) : added, removed, isNew }
}

const relative = (path: string, root: string) => (path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path)

const splitPath = (shown: string) => {
  const cut = shown.lastIndexOf('/')

  return cut === -1 ? { name: shown, folder: '' } : { name: shown.slice(cut + 1), folder: shown.slice(0, cut + 1) }
}

const isOpen = async ($: EngineInterface) => (await $.ui.panes()).some(pane => pane.id === PANE)

// VS Code when it's installed, else the Mac's default text editor.
const openFile = async ($: EngineInterface, path: string) => {
  try {
    const inCode = await $.process.run(['/usr/bin/open', '-a', 'Visual Studio Code', path], { timeoutMs: 10_000 })

    if (inCode.exitCode !== 0) {
      await $.process.run(['/usr/bin/open', '-t', path], { timeoutMs: 10_000 })
    }
  } catch {
    $.ui.toast(`Couldn't open ${path}`)
  }
}

const copyPaths = async ($: EngineInterface) => {
  const list = await read($, files)

  try {
    await $.process.run(['/usr/bin/pbcopy'], { stdin: `${list.map(file => file.path).join('\n')}\n`, timeoutMs: 5_000 })
    $.ui.toast(`Copied ${list.length} path${list.length === 1 ? '' : 's'}`)
  } catch {
    $.ui.toast("Couldn't reach the clipboard")
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'files',
      description: 'Show or hide the list of files Claude changed this session',
      argumentHint: '[clear]',
      immediate: true,
    })

    return started
  })

  on('command.run', { command: 'files' }, async ($, e) => {
    if (e.args.trim().toLowerCase() === 'clear') {
      await update($, files, () => [])

      return { text: 'Cleared the list of changed files.' }
    }

    if (await isOpen($)) {
      await $.ui.close({ id: PANE })

      return { text: 'Files pane closed. `/files` opens it again.' }
    }

    await $.ui.open({ id: PANE, title: TITLE })
    const count = (await read($, files)).length

    return { text: count === 0 ? 'Files pane open. Files Claude changes will show up there.' : `Files pane open: ${count} file${count === 1 ? '' : 's'} changed.` }
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)

    if (!FILE_TOOLS.has(e.tool) || ran.deny !== undefined || ran.isError === true) {
      return ran
    }

    const change = changeOf(e.tool, ran.result as FileResult)

    if (change === undefined) {
      return ran
    }

    const [root, now] = await Promise.all([$.session.root(), $.clock.now()])
    await update($, files, list => {
      const before = list.find(file => file.path === change.path)
      const entry: FileChange = {
        path: change.path,
        shown: relative(change.path, root),
        edits: (before?.edits ?? 0) + 1,
        added: (before?.added ?? 0) + change.added,
        removed: (before?.removed ?? 0) + change.removed,
        isNew: (before?.isNew ?? false) || change.isNew,
        at: now,
      }

      return [entry, ...list.filter(file => file.path !== change.path)]
    })

    // Once a session, a pointer to the pane.
    if (!(await read($, hasHinted)) && !(await isOpen($))) {
      await update($, hasHinted, () => true)
      $.ui.toast('Claude changed a file. /files lists every change this session.')
    }

    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const list = await read($, files)

    if (list.length === 0) {
      return (
        <Box flexDirection="column" paddingX={1}>
          <Text dimColor>No files changed yet.</Text>
          <Text dimColor wrap="wrap">
            Every file Claude edits or creates in this session shows up here.
          </Text>
        </Box>
      )
    }

    const added = list.reduce((sum, file) => sum + file.added, 0)
    const removed = list.reduce((sum, file) => sum + file.removed, 0)

    return (
      <Box flexDirection="column" paddingX={1} gap={0}>
        <Box flexDirection="row" gap={1}>
          <Text bold>{`${list.length} file${list.length === 1 ? '' : 's'}`}</Text>
          <Text color={ADDED}>{`+${added}`}</Text>
          <Text color={REMOVED}>{`−${removed}`}</Text>
        </Box>
        <Box flexDirection="column" marginY={1}>
          {list.map(file => {
            const { name, folder } = splitPath(file.shown)

            return (
              <Box key={`row:${file.path}`} flexDirection="column">
                <Button key={`open:${file.path}`} label={name} plain onPress={() => void openFile($, file.path)} />
                <Box flexDirection="row" gap={1} paddingLeft={e.surface === 'terminal' ? 0 : 1}>
                  {folder === '' ? null : (
                    <Text dimColor wrap="truncate-start">
                      {folder}
                    </Text>
                  )}
                  <Text color={ADDED}>{`+${file.added}`}</Text>
                  <Text color={REMOVED}>{`−${file.removed}`}</Text>
                  <Text dimColor>{file.isNew ? 'new' : `${file.edits} edit${file.edits === 1 ? '' : 's'}`}</Text>
                </Box>
              </Box>
            )
          })}
        </Box>
        <Box flexDirection="row" gap={1}>
          <Button key="copy" label="Copy paths" onPress={() => void copyPaths($)} />
          <Button key="clear" label="Clear" onPress={() => void update($, files, () => [])} />
        </Box>
      </Box>
    )
  })
}
