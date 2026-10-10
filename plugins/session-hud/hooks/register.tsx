import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Action, Limit, Snapshot, TurnInfo } from '../types'

const snapshot = atom({ plugin: 'session-hud', key: 'snapshot' } as const, null)
const turn = atom({ plugin: 'session-hud', key: 'turn' } as const, {})
const isOn = atom({ plugin: 'session-hud', key: 'isOn' } as const, true)
const action = atom({ plugin: 'session-hud', key: 'action' } as const, 'idle')

const REFRESH_MS = 5_000
const CONFIRM_MS = 5_000

// The labels the desktop app's effort picker uses.
const EFFORT_LABELS: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra', max: 'Max' }
const LIMIT_LABELS: Record<string, string> = { five_hour: '5-hour limit', seven_day: 'Weekly limit', spend_limit: 'Spend limit' }

// iOS system colors: fine, getting full, nearly out.
const LEVEL_COLORS = { ok: '#34C759', warn: '#FF9F0A', high: '#FF453A' } as const
const level = (percent: number) => (percent >= 90 ? 'high' : percent >= 70 ? 'warn' : 'ok')

const HANDOFF_PROMPT = [
  'Write a handoff note so a fresh session with no memory of this conversation can carry on the work.',
  'Use these sections: Goal (one or two sentences); Current state (what is done, what was verified and what was not);',
  'Decisions and constraints (each with its reason); Files and places (paths, repos, URLs that matter);',
  'Next steps (in order); Open questions.',
  'Be specific: names, paths, commands, versions. Leave out pleasantries and settled detours that do not affect the next steps.',
  'Keep it under 400 words. Reply with the note alone.',
].join(' ')

// claude-opus-5-5[1m] -> Opus 5.5 1M; claude-haiku-4-5-20251001 -> Haiku 4.5
const modelName = (id: string) => {
  const isLong = /\[1m\]/i.test(id)
  const parts = id
    .replace(/\[.*?\]/g, '')
    .replace(/^claude-/, '')
    .split('-')
    .filter(part => !/^\d{8}$/.test(part))
  const words = parts.filter(part => !/^\d+$/.test(part))
  const version = parts.filter(part => /^\d+$/.test(part)).join('.')
  const family = words.map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')

  return [family || id, version, isLong ? '1M' : ''].filter(Boolean).join(' ')
}

const tokens = (count: number) =>
  count >= 1_000_000
    ? `${+(count / 1_000_000).toFixed(count % 1_000_000 === 0 ? 0 : 1)}M`
    : count >= 1_000
      ? `${Math.round(count / 1_000)}k`
      : `${count}`

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const span = (ms: number) => {
  const minutes = Math.max(0, Math.round(ms / 60_000))

  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

const clockTime = (date: Date) => {
  const hours = date.getHours()
  const minutes = date.getMinutes()

  return `${hours % 12 || 12}${minutes === 0 ? '' : `:${String(minutes).padStart(2, '0')}`} ${hours < 12 ? 'AM' : 'PM'}`
}

// Within a day: "resets in 3h 20m"; within a week: "resets Mon 5 AM"; further out: "resets Oct 12".
const resetText = (iso: string, now: number) => {
  const date = new Date(iso)
  const ms = date.getTime() - now

  if (Number.isNaN(ms)) {
    return undefined
  }

  if (ms < 24 * 3_600_000) {
    return `resets in ${span(ms)}`
  }

  if (ms < 6 * 24 * 3_600_000) {
    return `resets ${DAYS[date.getDay()]} ${clockTime(date)}`
  }

  return `resets ${MONTHS[date.getMonth()]} ${date.getDate()}`
}

const meterSvg = (percent: number) => {
  const width = 96
  const fill = Math.max(0, Math.min(width, (width * percent) / 100))

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="6" viewBox="0 0 ${width} 6">`,
    `<rect width="${width}" height="6" rx="3" fill="#8E8E93" fill-opacity="0.28"/>`,
    fill > 0 ? `<rect width="${Math.max(fill, 6)}" height="6" rx="3" fill="${LEVEL_COLORS[level(percent)]}"/>` : '',
    '</svg>',
  ].join('')
}

const meterText = (percent: number) => {
  const clamped = Math.max(0, Math.min(100, percent))
  // Any use at all shows at least one block.
  const filled = clamped > 0 ? Math.max(1, Math.round(clamped / 10)) : 0

  return { filled: '█'.repeat(filled), empty: '░'.repeat(10 - filled) }
}

const refresh = async ($: EngineInterface) => {
  const [usage, model, now] = await Promise.all([$.session.usage(), $.session.model(), $.clock.now()])
  const next: Snapshot = {
    model,
    contextTokens: usage.context.tokens,
    contextWindow: usage.context.window,
    contextPercent: usage.context.percent,
    limits: usage.rateLimits.map(({ kind, percentUsed, resetsAt }) => ({ kind, percentUsed, resetsAt })),
    costUsd: usage.cost?.usd,
    startedAt: usage.startedAt,
    // Whole minutes, so the session clock and reset countdowns redraw once a minute and no more.
    at: Math.floor(now / 60_000) * 60_000,
  }

  if (JSON.stringify(await read($, snapshot)) !== JSON.stringify(next)) {
    await update($, snapshot, () => next)
  }
}

const setAction = ($: EngineInterface, next: Action) => update($, action, () => next)

const compact = async ($: EngineInterface) => {
  await setAction($, 'compacting')

  try {
    await $.command.run({ command: 'compact' })
  } catch (error) {
    $.ui.toast(`Couldn't compact: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    await setAction($, 'idle')
    void refresh($).catch(() => {})
  }
}

// A backup of the note, on the macOS clipboard: the desktop app gives mods no clipboard of its own.
const copyNote = async ($: EngineInterface, note: string) => {
  try {
    await $.process.run(['/usr/bin/pbcopy'], { stdin: note, timeoutMs: 5_000 })

    return true
  } catch {
    return false
  }
}

const freshStart = async ($: EngineInterface) => {
  await setAction($, 'handoff')

  try {
    if (!(await $.command.list()).some(command => command.name === 'clear')) {
      $.ui.toast("Fresh start needs /clear, which this app doesn't offer.")

      return
    }

    const reply = await $.model.fork({ prompt: HANDOFF_PROMPT })

    if (!reply.isAnswered) {
      $.ui.toast(reply.reason === 'nothing-to-fork' ? 'Nothing to hand off yet.' : `Couldn't write the handoff note (${reply.reason}).`)

      return
    }

    const note = reply.text.trim()
    const isCopied = await copyNote($, note)

    await $.command.run({ command: 'clear' })
    // The model reads the note as the fresh conversation's first row; the person sees it as a notice.
    await $.session.append({
      message: { type: 'user', content: [{ type: 'text', text: `Handoff note from the previous session, to continue from:\n\n${note}` }] },
    })
    await $.session.append({
      message: { type: 'system', content: [{ type: 'text', text: `Fresh start. Claude has this handoff note from the last session:\n\n${note}` }] },
    })
    $.ui.toast(isCopied ? 'Fresh start. The handoff note is also on your clipboard.' : 'Fresh start. Claude has the handoff note.')
  } catch (error) {
    $.ui.toast(`Fresh start stopped: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    await setAction($, 'idle')
    void refresh($).catch(() => {})
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'hud',
      description: 'Show or hide the session card above the message box',
      argumentHint: '[on|off]',
      immediate: true,
    })
    const saved = await $.store.get('isOn')
    await update($, isOn, () => saved !== false)
    await setAction($, 'idle')
    // A first reading that fails still leaves the timer running: the card fills in on its next tick.
    await refresh($).catch(() => {})
    $.clock.every(REFRESH_MS, () => void refresh($).catch(() => {}))

    return started
  })

  on('command.run', { command: 'hud' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const shown = arg === 'on' ? true : arg === 'off' ? false : !(await read($, isOn))
    await update($, isOn, () => shown)
    await $.store.set('isOn', shown)

    return { text: shown ? 'Session card shown.' : 'Session card hidden. Run /hud to show it again.' }
  })

  // The model and effort each request in the main conversation goes out with.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      const seen: TurnInfo = { model: e.model, effort: e.effort === undefined ? undefined : String(e.effort) }
      const current = await read($, turn)

      if (current.model !== seen.model || current.effort !== seen.effort) {
        await update($, turn, () => seen)
      }
    }

    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    void refresh($).catch(() => {})

    return done
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // What other mods draw here stays, above the card.
    const below = await next(e)
    const data = await read($, snapshot)

    if (e.props.hasSurvey || data === null || !(await read($, isOn))) {
      return below
    }

    const { model, effort } = await read($, turn)
    const current = await read($, action)
    const { Box, Button, Text } = $.ui.resolve(e)
    // The terminal has no Svg: its meters are block characters.
    const Svg = e.surface === 'terminal' ? undefined : $.ui.resolve(e).Svg

    const meter = (percent: number) => {
      if (Svg === undefined) {
        const { filled, empty } = meterText(percent)

        return (
          <Text>
            <Text color={LEVEL_COLORS[level(percent)]}>{filled}</Text>
            <Text dimColor>{empty}</Text>
          </Text>
        )
      }

      return <Svg source={meterSvg(percent)} alt={`${Math.round(percent)}% used`} />
    }

    // One column: a label, a reading, and a line of detail. Columns share the width evenly.
    const tile = (key: string, label: string, reading: RenderChildren[], detail: string) => (
      <Box key={key} flexDirection="column" flexGrow={1} width={0} minWidth={16}>
        <Text color="subtle" wrap="truncate-end">
          {label}
        </Text>
        <Box flexDirection="row" alignItems="center" gap={1}>
          {reading.filter(Boolean)}
        </Box>
        <Text color="subtle" wrap="truncate-end">
          {detail}
        </Text>
      </Box>
    )

    const contextTile =
      data.contextPercent === undefined
        ? tile('context', 'Context', [<Text bold>—</Text>], `${tokens(data.contextWindow)} window`)
        : tile(
            'context',
            'Context',
            [meter(data.contextPercent), <Text bold>{`${data.contextPercent}%`}</Text>],
            `${tokens(data.contextTokens ?? 0)} of ${tokens(data.contextWindow)} tokens`,
          )

    const limitTiles = data.limits.map((limit: Limit) =>
      tile(
        `limit-${limit.kind}`,
        LIMIT_LABELS[limit.kind] ?? limit.kind,
        [meter(limit.percentUsed), <Text bold>{`${Math.round(limit.percentUsed)}%`}</Text>],
        (limit.resetsAt === undefined ? undefined : resetText(limit.resetsAt, data.at)) ?? ' ',
      ),
    )

    const sessionTile = tile(
      'session',
      'Session',
      [<Text bold>{span(data.at - data.startedAt)}</Text>],
      data.costUsd === undefined ? ' ' : `API ≈ $${data.costUsd.toFixed(2)}`,
    )

    // The desktop app shows the model and effort right under the message box; elsewhere the card does.
    const modelTile =
      e.surface === 'desktop'
        ? null
        : tile('model', 'Model', [<Text bold>{modelName(model ?? data.model)}</Text>], effort === undefined ? ' ' : `${EFFORT_LABELS[effort] ?? effort} effort`)

    const isBusy = e.props.isWorking || current === 'compacting' || current === 'handoff'
    const isContextFull = (data.contextPercent ?? 0) >= 70

    const onCompact = () => {
      if (isBusy) {
        $.ui.toast('Wait until Claude finishes, then compact.')

        return
      }

      void compact($)
    }

    const onFreshStart = async () => {
      if (isBusy) {
        $.ui.toast('Wait until Claude finishes, then start fresh.')

        return
      }

      // First press asks; a second press within a few seconds goes ahead.
      if (current !== 'confirm') {
        await setAction($, 'confirm')
        // One read-and-write, so a press that lands as the timer fires (Compacting, the handoff) stands.
        $.clock.after(CONFIRM_MS, () => void update($, action, now => (now === 'confirm' ? 'idle' : now)).catch(() => {}))

        return
      }

      void freshStart($)
    }

    const actions = (
      <Box key="actions" flexDirection="column" alignItems="flex-end" justifyContent="center" gap={0}>
        <Button
          key="compact"
          label={current === 'compacting' ? 'Compacting…' : 'Compact'}
          variant={isContextFull ? 'primary' : 'secondary'}
          dimColor={isBusy && current !== 'compacting'}
          onPress={onCompact}
        />
        <Button
          key="fresh"
          label={current === 'handoff' ? 'Writing handoff…' : current === 'confirm' ? 'Press again to start fresh' : 'Fresh start'}
          variant={current === 'confirm' ? 'primary' : 'secondary'}
          dimColor={isBusy && current !== 'handoff'}
          onPress={onFreshStart}
        />
      </Box>
    )

    return (
      <Box flexDirection="column">
        {below}
        <Box flexDirection="row" alignItems="center" columnGap={3} paddingX={1}>
          {[modelTile, contextTile, ...limitTiles, sessionTile, actions].filter(Boolean)}
        </Box>
      </Box>
    )
  })
}
