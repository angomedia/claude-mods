import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Tally } from '../types'

const isOn = atom({ plugin: 'turn-summary', key: 'isOn' } as const, true)
const tally = atom({ plugin: 'turn-summary', key: 'tally' } as const, null)
const done = atom({ plugin: 'turn-summary', key: 'done' } as const, [])

const KEEP = 100
const FILE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])

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
      : { path: result.notebook_path, added: lineCount(result.new_source), removed: lineCount(result.old_source) }
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

  // A new file has no patch: all of it is new.
  if (tool === 'Write' && result.type === 'create' && added === 0) {
    added = lineCount(result.content)
  }

  return { path: result.filePath, added, removed }
}

const duration = (ms: number) => {
  const seconds = Math.round(ms / 1000)

  if (seconds < 60) {
    return `${seconds}s`
  }

  const minutes = Math.floor(seconds / 60)

  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`
const baseName = (path: string) => path.split('/').filter(Boolean).pop() ?? path

// "9 tools · register.tsx +12 −3", or "3 files +42 −10" past two files.
const describe = (counts: Tally) => {
  const parts: string[] = []

  if (counts.tools > 0) {
    parts.push(plural(counts.tools, 'tool'))
  }

  if (counts.files.length > 0) {
    const names = counts.files.length <= 2 ? counts.files.map(baseName).join(', ') : plural(counts.files.length, 'file')
    parts.push(`${names} +${counts.added} −${counts.removed}`)
  }

  return parts.join(' · ')
}

// The terminal draws the footer under each turn; other surfaces get the status line.
const showStatus = async ($: EngineInterface, text: string | undefined) => {
  if ((await $.session.surface()) !== 'terminal') {
    $.ui.status(text)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'summary',
      description: 'Turn the after-each-reply summary (time, tools, files changed) on or off',
      argumentHint: '[on|off]',
      immediate: true,
    })
    const saved = await $.store.get('isOn')
    await update($, isOn, () => saved !== false)

    return started
  })

  on('command.run', { command: 'summary' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const shown = arg === 'on' ? true : arg === 'off' ? false : !(await read($, isOn))
    await update($, isOn, () => shown)
    await $.store.set('isOn', shown)

    if (!shown) {
      $.ui.status(undefined)
    }

    return { text: shown ? 'Reply summaries on.' : 'Reply summaries off. Run /summary to turn them back on.' }
  })

  on('turn.start', async ($, e, next) => {
    await update($, tally, () => ({ tools: 0, files: [], added: 0, removed: 0 }))

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)

    if ((await read($, tally)) === null) {
      return ran
    }

    const change = FILE_TOOLS.has(e.tool) && ran.deny === undefined && ran.isError !== true ? changeOf(e.tool, ran.result as FileResult) : undefined

    await update($, tally, current =>
      current === null
        ? null
        : {
            tools: current.tools + 1,
            files: change === undefined || current.files.includes(change.path) ? current.files : [...current.files, change.path],
            added: current.added + (change?.added ?? 0),
            removed: current.removed + (change?.removed ?? 0),
          },
    )

    if (await read($, isOn)) {
      const counts = await read($, tally)
      await showStatus($, counts === null ? undefined : `Working · ${describe(counts)}`)
    }

    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const finished = await next(e)

    if (e.agentId !== undefined) {
      return finished
    }

    const counts = (await read($, tally)) ?? { tools: 0, files: [], added: 0, removed: 0 }
    const detail = describe(counts)
    await update($, tally, () => null)
    await update($, done, list => [...list, { durationMs: e.durationMs, text: detail }].slice(-KEEP))

    if (await read($, isOn)) {
      const how = e.isAborted ? 'Stopped' : 'Last reply'
      await showStatus($, [`${how} · ${duration(e.durationMs)}`, detail].filter(Boolean).join(' · '))
    }

    return finished
  })

  // The terminal's "Baked for 3s" line under each turn.
  on('ui.render', { component: 'TurnDuration' }, async ($, e, next) => {
    if (!(await read($, isOn))) {
      return next(e)
    }

    const list = await read($, done)
    const closest = list.reduce<{ text: string; gap: number } | undefined>((best, one) => {
      const gap = Math.abs(one.durationMs - e.props.durationMs)

      return gap <= 2_000 && (best === undefined || gap < best.gap) ? { text: one.text, gap } : best
    }, undefined)

    if (closest === undefined || closest.text === '') {
      return next(e)
    }

    const { Text } = $.ui.resolve(e)

    return <Text dimColor>{`✻ ${e.props.word} for ${duration(e.props.durationMs)} · ${closest.text}`}</Text>
  })
}
