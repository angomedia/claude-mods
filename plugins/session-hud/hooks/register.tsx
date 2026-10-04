import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Limit, Snapshot, TurnInfo } from '../types'

const snapshot = atom({ plugin: 'session-hud', key: 'snapshot' } as const, null)
const turn = atom({ plugin: 'session-hud', key: 'turn' } as const, {})
const isOn = atom({ plugin: 'session-hud', key: 'isOn' } as const, true)

const REFRESH_MS = 5_000

// The labels the desktop app's effort picker uses.
const EFFORT_LABELS: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra', max: 'Max' }
const LIMIT_LABELS: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: 'Spend' }

// iOS system colors: fine, getting full, nearly out.
const LEVEL_COLORS = { ok: '#34C759', warn: '#FF9F0A', high: '#FF453A' } as const

const level = (percent: number) => (percent >= 90 ? 'high' : percent >= 70 ? 'warn' : 'ok')

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

const clockTime = (date: Date) => {
  const hours = date.getHours()
  const minutes = date.getMinutes()

  return `${hours % 12 || 12}${minutes === 0 ? '' : `:${String(minutes).padStart(2, '0')}`} ${hours < 12 ? 'AM' : 'PM'}`
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// Today: "2:40 PM"; within a week: "Tue 9 AM"; further out: "Oct 12".
const resetTime = (iso: string, now: number) => {
  const date = new Date(iso)

  if (Number.isNaN(date.getTime())) {
    return undefined
  }

  if (date.toDateString() === new Date(now).toDateString()) {
    return clockTime(date)
  }

  if (date.getTime() - now < 6 * 24 * 3_600_000) {
    return `${DAYS[date.getDay()]} ${clockTime(date)}`
  }

  return `${MONTHS[date.getMonth()]} ${date.getDate()}`
}

const duration = (ms: number) => {
  const minutes = Math.max(0, Math.floor(ms / 60_000))

  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

const meterSvg = (percent: number) => {
  const width = 44
  const fill = Math.max(0, Math.min(width, (width * percent) / 100))

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="6" viewBox="0 0 ${width} 6">`,
    `<rect width="${width}" height="6" rx="3" fill="#8E8E93" fill-opacity="0.28"/>`,
    fill > 0 ? `<rect width="${Math.max(fill, 6)}" height="6" rx="3" fill="${LEVEL_COLORS[level(percent)]}"/>` : '',
    '</svg>',
  ].join('')
}

const meterText = (percent: number) => {
  const filled = Math.round(Math.max(0, Math.min(100, percent)) / 12.5)

  return { filled: '█'.repeat(filled), empty: '░'.repeat(8 - filled) }
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
    // Whole minutes, so the session clock and reset times redraw once a minute and no more.
    at: Math.floor(now / 60_000) * 60_000,
  }
  const current = await read($, snapshot)

  if (JSON.stringify(current) !== JSON.stringify(next)) {
    await update($, snapshot, () => next)
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
    await refresh($)
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
    const data = await read($, snapshot)

    if (e.props.hasSurvey || data === null || !(await read($, isOn))) {
      return next(e)
    }

    const { model, effort } = await read($, turn)
    const { Box, Text } = $.ui.resolve(e)
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

    const segment = (key: string, children: unknown[]) => (
      <Box key={key} flexDirection="row" alignItems="center" gap={1}>
        {children.filter(Boolean)}
      </Box>
    )

    const segments = [
      segment('model', [
        <Text bold>{modelName(model ?? data.model)}</Text>,
        effort === undefined ? null : <Text color="subtle">{EFFORT_LABELS[effort] ?? effort}</Text>,
      ]),
      segment('context', [
        <Text color="subtle">Context</Text>,
        data.contextPercent === undefined ? <Text color="subtle">no reply yet</Text> : meter(data.contextPercent),
        data.contextPercent === undefined ? null : <Text>{`${data.contextPercent}%`}</Text>,
        <Text color="subtle">
          {data.contextTokens === undefined ? tokens(data.contextWindow) : `${tokens(data.contextTokens)}/${tokens(data.contextWindow)}`}
        </Text>,
      ]),
      ...data.limits.map((limit: Limit) => {
        const resets = limit.resetsAt === undefined ? undefined : resetTime(limit.resetsAt, data.at)

        return segment(`limit-${limit.kind}`, [
          <Text color="subtle">{LIMIT_LABELS[limit.kind] ?? limit.kind}</Text>,
          meter(limit.percentUsed),
          <Text>{`${Math.round(limit.percentUsed)}%`}</Text>,
          resets === undefined ? null : <Text color="subtle">{`resets ${resets}`}</Text>,
        ])
      }),
      data.costUsd === undefined ? null : segment('cost', [<Text color="subtle">{`$${data.costUsd.toFixed(2)}`}</Text>]),
      segment('time', [<Text color="subtle">{duration(data.at - data.startedAt)}</Text>]),
    ].filter(Boolean)

    return (
      <Box
        borderStyle="round"
        borderColor="promptBorder"
        paddingX={1}
        flexDirection="row"
        flexWrap="wrap"
        columnGap={3}
        rowGap={0}
      >
        {segments}
      </Box>
    )
  })
}
