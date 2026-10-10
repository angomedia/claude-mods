import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, Register } from 'claude-code'

import type { Overview, PlanItem, Thread, ThreadStatus } from '../types'

const threads = atom({ plugin: 'agent-threads', key: 'threads' } as const, [])
const overview = atom({ plugin: 'agent-threads', key: 'overview' } as const, null)
const isAuto = atom({ plugin: 'agent-threads', key: 'isAuto' } as const, true)
const hasAutoOpened = atom({ plugin: 'agent-threads', key: 'hasAutoOpened' } as const, false)
const mainTurn = atom({ plugin: 'agent-threads', key: 'mainTurn' } as const, 0)
const typical = atom({ plugin: 'agent-threads', key: 'typical' } as const, {})

const PANE = 'agent-threads'
const TITLE = 'Threads'
const MAIN = 'main'
const TICK_MS = 2_000
// How many past runs of each thread type the estimate learns from.
const HISTORY_SIZE = 25
// Tool calls a thread is assumed to need before its type has a history.
const DEFAULT_TOOLS = { main: 8, agent: 15 }
const MIN_TYPICAL_TOOLS = 4

const ENDED = new Set<ThreadStatus>(['completed', 'failed', 'killed'])
const isEnded = (thread: Thread) => ENDED.has(thread.status)

// iOS system colors, as session-hud uses them.
const COLORS = { blue: '#0A84FF', green: '#34C759', orange: '#FF9F0A', red: '#FF453A', gray: '#8E8E93' } as const

const LOOK: Record<ThreadStatus, { glyph: string; color: string }> = {
  pending: { glyph: '○', color: COLORS.gray },
  running: { glyph: '●', color: COLORS.blue },
  waiting: { glyph: '◐', color: COLORS.orange },
  idle: { glyph: '◌', color: COLORS.gray },
  completed: { glyph: '✓', color: COLORS.green },
  failed: { glyph: '✕', color: COLORS.red },
  killed: { glyph: '■', color: COLORS.gray },
}

// The labels the desktop app's effort picker uses.
const EFFORT_LABELS: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra', max: 'Max' }

// Anthropic API list prices, US dollars per million tokens (September 2026). A cache write is
// priced at the 5-minute rate, 1.25x input. Fast mode and partner clouds price differently.
type Price = { input: number; output: number; cacheRead: number }
const PRICES: ReadonlyArray<readonly [RegExp, Price]> = [
  [/(fable|mythos)-5-1/, { input: 10, output: 50, cacheRead: 0.25 }],
  [/fable|mythos/, { input: 10, output: 50, cacheRead: 1 }],
  [/opus-5-5/, { input: 4, output: 20, cacheRead: 0.2 }],
  [/opus-(5|4-[5-9])/, { input: 5, output: 25, cacheRead: 0.5 }],
  [/opus/, { input: 15, output: 75, cacheRead: 1.5 }],
  [/sonnet-5/, { input: 2, output: 10, cacheRead: 0.2 }],
  [/sonnet/, { input: 3, output: 15, cacheRead: 0.3 }],
  [/haiku-4/, { input: 1, output: 5, cacheRead: 0.1 }],
  [/haiku/, { input: 0.8, output: 4, cacheRead: 0.08 }],
]

const costOf = (model: string, usage: ModelUsage) => {
  const price = PRICES.find(([pattern]) => pattern.test(model))?.[1]

  if (price === undefined) {
    return undefined
  }

  const dollars =
    usage.input_tokens * price.input +
    usage.cache_creation_input_tokens * price.input * 1.25 +
    usage.cache_read_input_tokens * price.cacheRead +
    usage.output_tokens * price.output

  return dollars / 1_000_000
}

// claude-opus-5-5[1m] -> Opus 5.5 1M; us.anthropic.claude-haiku-4-5-20251001 -> Haiku 4.5
const modelName = (id: string) => {
  const isLong = /\[1m\]/i.test(id)
  const parts = id
    .replace(/\[.*?\]/g, '')
    .replace(/^(.*\.)?claude-/, '')
    .split('-')
    .filter(part => !/^\d{8}$/.test(part))
  const words = parts.filter(part => !/^\d+$/.test(part))
  const version = parts.filter(part => /^\d+$/.test(part)).join('.')
  const family = words.map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')

  return [family || id, version, isLong ? '1M' : ''].filter(Boolean).join(' ')
}

const tokens = (count: number) =>
  count >= 1_000_000 ? `${+(count / 1_000_000).toFixed(1)}M` : count >= 1_000 ? `${Math.round(count / 1_000)}k` : `${count}`

const span = (ms: number) => {
  const seconds = Math.max(0, Math.round(ms / 1_000))
  const minutes = Math.floor(seconds / 60)

  if (seconds < 60) {
    return `${seconds}s`
  }

  if (minutes < 10) {
    return `${minutes}m ${seconds % 60}s`
  }

  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

const dollars = (usd: number) => (usd > 0 && usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`)

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

const baseName = (path: string | undefined) => (path ?? '').split('/').filter(Boolean).pop() ?? ''

const short = (text: string, max = 60) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

// The arguments of the tools this mod reads, loosely: every tool's are spread on `tool.call`'s input.
type ToolInput = {
  file_path?: string
  notebook_path?: string
  description?: string
  skill?: string
  todos?: ReadonlyArray<{ content: string; status: PlanItem['status']; activeForm: string }>
  subject?: string
  activeForm?: string
  taskId?: string
  status?: string
}

// What a tool call is doing, in a few plain words (typing-bubble's captions).
const describeTool = (tool: string, input: ToolInput) => {
  switch (tool) {
    case 'Read':
      return `Reading ${baseName(input.file_path)}`
    case 'Edit':
    case 'NotebookEdit':
      return `Editing ${baseName(input.file_path ?? input.notebook_path)}`
    case 'Write':
      return `Writing ${baseName(input.file_path)}`
    case 'Bash':
      return input.description === undefined ? 'Running a command' : short(input.description)
    case 'Grep':
    case 'Glob':
      return 'Searching the code'
    case 'WebSearch':
      return 'Searching the web'
    case 'WebFetch':
      return 'Reading a web page'
    case 'Agent':
      return input.description === undefined ? 'Starting a subagent' : `Running agent: ${short(input.description)}`
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
      return 'Updating the plan'
    case 'Skill':
      return input.skill === undefined ? 'Using a skill' : `Using ${input.skill}`
    case 'ToolSearch':
      return 'Loading tools'
    case 'AskUserQuestion':
      return 'Asking you a question'
    default:
      // mcp__server__tool_name -> "Using tool name"
      return `Using ${tool.split('__').pop()?.replace(/[_-]+/g, ' ') ?? tool}`
  }
}

const PLAN_STATUSES = new Set(['pending', 'in_progress', 'completed'])
const isPlanStatus = (status: string | undefined): status is PlanItem['status'] => status !== undefined && PLAN_STATUSES.has(status)

// How a successful call changes its thread's task list; undefined for a call that leaves it alone.
const planAfter = (tool: string, input: ToolInput, result: unknown): ((plan: readonly PlanItem[]) => PlanItem[]) | undefined => {
  if (tool === 'TodoWrite' && input.todos !== undefined) {
    const items = input.todos.map((todo, index) => ({ id: `todo-${index}`, text: todo.content, active: todo.activeForm, status: todo.status }))

    return () => items
  }

  if (tool === 'TaskCreate') {
    const id = (result as { task?: { id?: string } } | undefined)?.task?.id

    if (id === undefined) {
      return undefined
    }

    const item: PlanItem = { id, text: input.subject ?? '', active: input.activeForm, status: 'pending' }

    return plan => [...plan.filter(one => one.id !== id), item]
  }

  if (tool === 'TaskUpdate' && input.taskId !== undefined) {
    const { taskId, status, subject, activeForm } = input

    return plan =>
      status === 'deleted'
        ? plan.filter(one => one.id !== taskId)
        : plan.map(one =>
            one.id === taskId
              ? { ...one, text: subject ?? one.text, active: activeForm ?? one.active, status: isPlanStatus(status) ? status : one.status }
              : one,
          )
  }

  return undefined
}

const blank = (id: string, now: number, turn: number): Thread => ({
  id,
  parentId: id === MAIN ? undefined : MAIN,
  title: id === MAIN ? 'Main thread' : 'Agent',
  type: id === MAIN ? 'main' : 'agent',
  status: id === MAIN ? 'idle' : 'running',
  turn,
  startedAt: now,
  tools: 0,
  turnTools: 0,
  plan: [],
  costUsd: 0,
  hasUnpriced: false,
})

// Applies `fn` to one thread, adding it first if it is new; writes nothing when `fn` changes nothing.
const change = async ($: EngineInterface, id: string, fn: (thread: Thread) => Thread) => {
  const [now, turn, current] = await Promise.all([$.clock.now(), read($, mainTurn), read($, threads)])
  const found = current.find(thread => thread.id === id)

  if (found !== undefined && fn(found) === found) {
    return
  }

  await update($, threads, list => {
    const before = list.find(thread => thread.id === id)
    const after = fn(before ?? blank(id, now, turn))

    return before === undefined ? [...list, after] : list.map(thread => (thread.id === id ? after : thread))
  })
}

type History = Record<string, number[]>

const asHistory = (value: unknown): History => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {}
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, list]) => [key, Array.isArray(list) ? list.filter((n): n is number => typeof n === 'number') : []]),
  )
}

const median = (list: readonly number[]) => {
  const sorted = [...list].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)

  return sorted.length % 2 === 1 ? (sorted[middle] ?? 0) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
}

const typicalOf = (history: History) =>
  Object.fromEntries(
    Object.entries(history)
      .filter(([, list]) => list.length > 0)
      .map(([key, list]) => [key, Math.max(MIN_TYPICAL_TOOLS, Math.round(median(list)))]),
  )

// Keeps how many tool calls a finished run of this type took, so later bars of its type have a measure.
const learn = async ($: EngineInterface, key: string, tools: number) => {
  const history = asHistory(await $.store.get('history'))
  const next = { ...history, [key]: [...(history[key] ?? []), tools].slice(-HISTORY_SIZE) }
  await $.store.set('history', next)
  await update($, typical, () => typicalOf(next))
}

// Up to 90% at the usual number of tool calls, then creeping toward 95%: only the end of a run fills the bar.
const estimate = (tools: number, usual: number) => {
  const ratio = tools / usual
  const share = ratio <= 1 ? 0.9 * ratio : 0.9 + 0.05 * (1 - Math.exp(-(ratio - 1)))

  return Math.max(3, Math.min(95, Math.round(share * 100)))
}

type Progress = { percent: number; color: string; reading: string; detail: string }

const progressOf = (thread: Thread, usualByType: Record<string, number>): Progress => {
  const done = thread.plan.filter(item => item.status === 'completed').length
  const hasPlan = thread.plan.length > 0
  const planPercent = hasPlan ? Math.round((100 * done) / thread.plan.length) : 0
  const planDetail = `${done} of ${plural(thread.plan.length, 'step')}`
  const tools = thread.id === MAIN ? thread.turnTools : thread.tools
  const usual = usualByType[thread.type] ?? (thread.id === MAIN ? DEFAULT_TOOLS.main : DEFAULT_TOOLS.agent)
  const guess = hasPlan ? planPercent : estimate(tools, usual)
  const at = (percent: number, color: string, detail: string, isGuess = false): Progress => ({
    percent,
    color,
    reading: `${isGuess ? '~' : ''}${percent}%`,
    detail,
  })

  switch (thread.status) {
    case 'completed':
      return at(100, COLORS.green, hasPlan ? planDetail : 'Done')
    case 'failed':
      return at(guess, COLORS.red, 'Failed', !hasPlan)
    case 'killed':
      return at(guess, COLORS.gray, 'Stopped', !hasPlan)
    case 'pending':
      return at(0, COLORS.gray, 'Waiting to start')
    case 'idle':
      if (thread.id !== MAIN) {
        return at(hasPlan ? planPercent : 100, COLORS.gray, 'Idle until it gets a message')
      }

      if (hasPlan) {
        return at(planPercent, done === thread.plan.length ? COLORS.green : COLORS.blue, `${planDetail} · waiting for you`)
      }

      return thread.endedAt === undefined ? at(0, COLORS.gray, 'Not started') : at(100, COLORS.green, 'Done · waiting for you')
    default: {
      const color = thread.status === 'waiting' ? COLORS.orange : COLORS.blue

      return hasPlan ? at(planPercent, color, planDetail) : at(guess, color, `${tools} of ~${plural(usual, 'tool')}`, true)
    }
  }
}

const isOpen = async ($: EngineInterface) => (await $.ui.panes()).some(pane => pane.id === PANE)

// The list's word on an agent's status; a finished agent runs again only once a step of its own says so.
const syncAgents = async ($: EngineInterface) => {
  const agents = await $.agent.list()
  const merge = (list: readonly Thread[]) =>
    list.map(thread => {
      const agent = agents.find(one => one.id === thread.id)

      if (agent === undefined || thread.id === MAIN) {
        return thread
      }

      const status = isEnded(thread) && !ENDED.has(agent.status) ? thread.status : agent.status
      const title = thread.title === 'Agent' ? agent.description || agent.name || agent.type : thread.title
      const type = thread.type === 'agent' ? agent.type : thread.type
      const parentId = agent.parentId ?? thread.parentId

      return status === thread.status && title === thread.title && type === thread.type && parentId === thread.parentId
        ? thread
        : { ...thread, status, title, type, parentId }
    })

  const current = await read($, threads)

  if (merge(current).some((thread, index) => thread !== current[index])) {
    await update($, threads, merge)
  }
}

const refresh = async ($: EngineInterface) => {
  const [usage, now, list] = await Promise.all([$.session.usage(), $.clock.now(), read($, threads)])
  const isBusy = list.some(thread => thread.status === 'running' || thread.status === 'waiting' || thread.status === 'pending')
  const next: Overview = {
    costUsd: usage.cost?.usd,
    contextPercent: usage.context.percent,
    contextTokens: usage.context.tokens,
    contextWindow: usage.context.window,
    startedAt: usage.startedAt,
    at: isBusy ? Math.floor(now / 1_000) * 1_000 : Math.floor(now / 60_000) * 60_000,
  }

  if (JSON.stringify(await read($, overview)) !== JSON.stringify(next)) {
    await update($, overview, () => next)
  }

  if (list.some(thread => thread.id !== MAIN && !isEnded(thread))) {
    await syncAgents($)
  }
}

const tick = async ($: EngineInterface) => {
  if (await isOpen($)) {
    await refresh($)
  } else if ((await read($, threads)).some(thread => thread.id !== MAIN && !isEnded(thread))) {
    await syncAgents($)
  }
}

const openPane = async ($: EngineInterface) => {
  await refresh($)

  return $.ui.open({ id: PANE, title: TITLE })
}

// Once a session, the first subagent opens the pane, unless the person turned that off.
const autoOpen = async ($: EngineInterface) => {
  if (!(await read($, isAuto)) || (await read($, hasAutoOpened)) || (await isOpen($))) {
    return
  }

  await update($, hasAutoOpened, () => true)
  const opened = await openPane($)

  if (!opened.isPlaced) {
    $.ui.toast('Subagents are running. /threads shows each one with its progress.')
  }
}

const clearFinished = ($: EngineInterface) => update($, threads, list => list.filter(thread => thread.id === MAIN || !isEnded(thread)))

// The main thread first, then each subagent after the thread that started it.
const treeOrder = (list: readonly Thread[]) => {
  const ordered: { thread: Thread; depth: number }[] = []
  const visit = (parentId: string, depth: number) => {
    for (const child of list.filter(thread => thread.parentId === parentId)) {
      ordered.push({ thread: child, depth })

      if (depth < 6) {
        visit(child.id, depth + 1)
      }
    }
  }
  const main = list.find(thread => thread.id === MAIN)

  if (main !== undefined) {
    ordered.push({ thread: main, depth: 0 })
  }

  visit(MAIN, 1)
  // A thread whose parent isn't listed (cleared, or never seen) goes at the end, under main.
  const placed = new Set(ordered.map(one => one.thread.id))

  for (const orphan of list.filter(thread => !placed.has(thread.id))) {
    ordered.push({ thread: orphan, depth: 1 })
  }

  return ordered
}

const meterSvg = (percent: number, color: string, width: number) => {
  const fill = Math.max(0, Math.min(width, (width * percent) / 100))

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="6" viewBox="0 0 ${width} 6">`,
    `<rect width="${width}" height="6" rx="3" fill="#8E8E93" fill-opacity="0.28"/>`,
    fill > 0 ? `<rect width="${Math.max(fill, 6)}" height="6" rx="3" fill="${color}"/>` : '',
    '</svg>',
  ].join('')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'threads',
      description: 'Show or hide the threads pane: the main thread and each subagent, with model, cost and progress',
      argumentHint: '[clear|auto on|auto off]',
      immediate: true,
    })
    const [savedAuto, history] = await Promise.all([$.store.get('isAuto'), $.store.get('history')])
    await update($, isAuto, () => savedAuto !== false)
    await update($, typical, () => typicalOf(asHistory(history)))
    await change($, MAIN, thread => thread)
    await refresh($)
    $.clock.every(TICK_MS, () => void tick($).catch(() => {}))

    return started
  })

  // /clear starts the conversation over: so does the list.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      const now = await $.clock.now()
      await update($, mainTurn, () => 0)
      await update($, threads, () => [blank(MAIN, now, 0)])
      await update($, hasAutoOpened, () => false)
    }

    return next(e)
  })

  on('command.run', { command: 'threads' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase().replace(/\s+/g, ' ')

    if (arg === 'clear') {
      await clearFinished($)

      return { text: 'Cleared the finished subagents from the threads pane.' }
    }

    if (arg === 'auto on' || arg === 'auto off') {
      const isOn = arg === 'auto on'
      await update($, isAuto, () => isOn)
      await $.store.set('isAuto', isOn)

      return {
        text: isOn
          ? 'The threads pane will open by itself when the first subagent starts.'
          : 'The threads pane opens only when you run /threads.',
      }
    }

    if (!['', 'on', 'open', 'off', 'close'].includes(arg)) {
      return { text: 'Usage: /threads to show or hide the pane, /threads clear to drop finished subagents, /threads auto on|off.' }
    }

    const isShown = await isOpen($)
    const wantsOpen = arg === 'on' || arg === 'open' ? true : arg === 'off' || arg === 'close' ? false : !isShown

    if (!wantsOpen) {
      if (isShown) {
        await $.ui.close({ id: PANE })
      }

      return { text: 'Threads pane closed. /threads opens it again.' }
    }

    await openPane($)
    const count = (await read($, threads)).filter(thread => thread.id !== MAIN).length

    return {
      text:
        count === 0
          ? 'Threads pane open. Subagents show up there as Claude starts them.'
          : `Threads pane open: the main thread and ${plural(count, 'subagent')}.`,
    }
  })

  on('turn.start', async ($, e, next) => {
    const started = await next(e)
    await update($, mainTurn, turn => turn + 1)
    const now = await $.clock.now()
    // A finished task list belongs to the turn that finished it.
    await change($, MAIN, thread => ({
      ...thread,
      status: 'running',
      turnStartedAt: now,
      turnTools: 0,
      activity: undefined,
      plan: thread.plan.every(item => item.status === 'completed') ? [] : thread.plan,
    }))

    return started
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    const id = started.agentId

    if (id === undefined) {
      return started
    }

    const [now, turn] = await Promise.all([$.clock.now(), read($, mainTurn)])
    // Its first steps may have landed already: what they recorded stays.
    await change($, id, thread => ({
      ...thread,
      parentId: e.parentAgentId ?? MAIN,
      title: e.description.trim() || e.name || e.subagentType,
      type: e.subagentType,
      model: thread.model ?? started.model,
      status: isEnded(thread) ? thread.status : 'running',
      turn,
      startedAt: Math.min(thread.startedAt, now),
    }))
    await autoOpen($).catch(() => {})

    return started
  })

  // Each model request: the model and effort it goes out with, then what it cost.
  on('turn.step', async function* ($, e, next) {
    const id = e.agentId ?? MAIN
    const effort = e.effort === undefined ? undefined : String(e.effort)
    await change($, id, thread => {
      // A finished subagent that steps again was resumed.
      const isResumed = id !== MAIN && isEnded(thread)

      return thread.model === e.model && thread.effort === effort && !isResumed
        ? thread
        : { ...thread, model: e.model, effort, ...(isResumed ? { status: 'running' as const, endedAt: undefined } : {}) }
    })

    const result = yield* next(e)
    const usage = result.usage

    if (usage !== null) {
      const cost = costOf(usage.model || e.model, usage)
      await change($, id, thread => ({
        ...thread,
        costUsd: thread.costUsd + (cost ?? 0),
        hasUnpriced: thread.hasUnpriced || cost === undefined,
        contextTokens: usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens,
      }))
    }

    return result
  })

  on('tool.call', async ($, e, next) => {
    const id = e.agentId ?? MAIN
    const input = e as unknown as ToolInput
    const activity = describeTool(e.tool, input)
    await change($, id, thread => ({ ...thread, tools: thread.tools + 1, turnTools: thread.turnTools + 1, activity }))

    const ran = await next(e)

    if (ran.deny === undefined && ran.isError !== true) {
      const after = planAfter(e.tool, input, ran.result)

      if (after !== undefined) {
        await change($, id, thread => ({ ...thread, plan: after(thread.plan) }))
      }
    }

    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const id = e.agentId ?? MAIN
    const now = await $.clock.now()
    const status: ThreadStatus = id === MAIN ? 'idle' : e.reason === 'answer' ? 'completed' : e.reason === 'aborted' ? 'killed' : 'failed'
    await change($, id, thread => ({ ...thread, status, endedAt: now, activity: undefined }))

    const thread = (await read($, threads)).find(one => one.id === id)

    // A main turn that used no tools was a chat, not work: it would teach the estimate nothing.
    if (thread !== undefined && e.reason === 'answer' && (id !== MAIN || thread.turnTools > 0)) {
      await learn($, thread.type, id === MAIN ? thread.turnTools : thread.tools)
    }

    void refresh($).catch(() => {})

    return done
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    // The terminal has no Svg: its meters are block characters.
    const Svg = e.surface === 'terminal' ? undefined : $.ui.resolve(e).Svg
    const [list, view, usual, turn] = await Promise.all([read($, threads), read($, overview), read($, typical), read($, mainTurn)])
    const at = view?.at ?? (await $.clock.now())
    const columns = e.props.bodyColumns
    const barCells = Math.max(6, Math.min(20, columns - 26))
    const barWidth = Math.max(80, Math.min(200, columns * 4))

    const meter = (percent: number, color: string) => {
      if (Svg === undefined) {
        const filled = percent > 0 ? Math.max(1, Math.round((percent / 100) * barCells)) : 0

        return (
          <Text>
            <Text color={color}>{'█'.repeat(filled)}</Text>
            <Text dimColor>{'░'.repeat(barCells - filled)}</Text>
          </Text>
        )
      }

      return <Svg source={meterSvg(percent, color, barWidth)} alt={`${percent}% done`} />
    }

    const subagents = list.filter(thread => thread.id !== MAIN)
    // This turn's subagents, and any still going from before: what Overall measures.
    const isCurrent = (thread: Thread) => thread.turn >= turn || !isEnded(thread)
    const current = subagents.filter(isCurrent)
    const earlier = subagents.filter(thread => !isCurrent(thread))
    const main = list.find(thread => thread.id === MAIN)
    const subagentCost = subagents.reduce((sum, thread) => sum + thread.costUsd, 0)
    // The session's exact total, less the subagents' estimates, is the main thread's share.
    const mainCost =
      view?.costUsd !== undefined && view.costUsd >= subagentCost ? view.costUsd - subagentCost : (main?.costUsd ?? 0)

    const progress = new Map(list.map(thread => [thread.id, progressOf(thread, usual)]))

    const overall = (() => {
      if (current.length === 0) {
        const own = main === undefined ? undefined : progress.get(MAIN)

        return { percent: own?.percent ?? 0, color: own?.color ?? COLORS.gray, reading: own?.reading ?? '0%', detail: 'No subagents this turn' }
      }

      const percent = Math.round(current.reduce((sum, thread) => sum + (progress.get(thread.id)?.percent ?? 0), 0) / current.length)
      const finished = current.filter(isEnded).length
      const running = current.filter(thread => thread.status === 'running').length
      const hasFailed = current.some(thread => thread.status === 'failed')
      const isGuess = current.some(thread => !isEnded(thread) && (progress.get(thread.id)?.reading.startsWith('~') ?? false))

      return {
        percent,
        color: hasFailed ? COLORS.orange : finished === current.length ? COLORS.green : COLORS.blue,
        reading: `${isGuess ? '~' : ''}${percent}%`,
        detail: [`${finished} of ${plural(current.length, 'agent')} done`, running > 0 ? `${running} running` : ''].filter(Boolean).join(' · '),
      }
    })()

    const sessionStats = [
      view === null ? '' : `${span(at - view.startedAt)} session`,
      view?.costUsd === undefined ? '' : `API ≈ ${dollars(view.costUsd)}`,
      subagents.length === 0 ? '' : plural(subagents.length, 'subagent'),
    ]
      .filter(Boolean)
      .join(' · ')

    const modelLabel = (thread: Thread) =>
      thread.model === undefined
        ? ''
        : [modelName(thread.model), thread.effort === undefined ? '' : (EFFORT_LABELS[thread.effort] ?? thread.effort)].filter(Boolean).join(' · ')

    const statsOf = (thread: Thread) => {
      if (thread.id === MAIN) {
        return [
          view === null ? '' : span(at - view.startedAt),
          plural(thread.tools, 'tool'),
          `≈ ${dollars(mainCost)}`,
          view?.contextPercent === undefined ? '' : `context ${view.contextPercent}%`,
        ]
          .filter(Boolean)
          .join(' · ')
      }

      return [
        span((thread.endedAt ?? at) - thread.startedAt),
        plural(thread.tools, 'tool'),
        thread.costUsd === 0 && thread.hasUnpriced ? 'cost unknown' : `≈ ${dollars(thread.costUsd)}${thread.hasUnpriced ? '+' : ''}`,
        thread.contextTokens === undefined ? '' : `${tokens(thread.contextTokens)} context`,
      ]
        .filter(Boolean)
        .join(' · ')
    }

    const activityOf = (thread: Thread) => {
      if (thread.status !== 'running' && thread.status !== 'waiting') {
        return undefined
      }

      const step = thread.plan.find(item => item.status === 'in_progress')

      return thread.activity ?? step?.active ?? step?.text
    }

    const row = (thread: Thread, depth: number) => {
      const look = LOOK[thread.status]
      const shown = progress.get(thread.id) ?? progressOf(thread, usual)
      const activity = activityOf(thread)

      return (
        <Box key={`thread:${thread.id}`} flexDirection="column" paddingLeft={depth * 2}>
          <Box flexDirection="row" gap={1}>
            <Text color={look.color}>{look.glyph}</Text>
            <Box flexGrow={1} width={0}>
              <Text bold wrap="truncate-end">
                {thread.title}
              </Text>
            </Box>
            <Text color="subtle" wrap="truncate-end">
              {modelLabel(thread)}
            </Text>
          </Box>
          <Box flexDirection="row" alignItems="center" gap={1} paddingLeft={2}>
            {meter(shown.percent, shown.color)}
            <Text bold>{shown.reading}</Text>
            <Text color="subtle" wrap="truncate-end">
              {shown.detail}
            </Text>
          </Box>
          {activity === undefined || activity === '' ? null : (
            <Box paddingLeft={2}>
              <Text wrap="truncate-end">{activity}</Text>
            </Box>
          )}
          <Box paddingLeft={2}>
            <Text color="subtle" wrap="truncate-end">
              {statsOf(thread)}
            </Text>
          </Box>
        </Box>
      )
    }

    // A finished subagent from an earlier turn: one dim line.
    const earlierRow = (thread: Thread) => {
      const look = LOOK[thread.status]

      return (
        <Box key={`earlier:${thread.id}`} flexDirection="row" gap={1}>
          <Text color={look.color}>{look.glyph}</Text>
          <Box flexGrow={1} width={0}>
            <Text dimColor wrap="truncate-end">
              {thread.title}
            </Text>
          </Box>
          <Text color="subtle">{`${span((thread.endedAt ?? at) - thread.startedAt)} · ≈ ${dollars(thread.costUsd)}`}</Text>
        </Box>
      )
    }

    const tree = treeOrder([...(main === undefined ? [] : [main]), ...current])

    return (
      <Box flexDirection="column" paddingX={1} gap={1}>
        <Box key="overall" flexDirection="column">
          <Text color="subtle">Overall</Text>
          <Box flexDirection="row" alignItems="center" gap={1}>
            {meter(overall.percent, overall.color)}
            <Text bold>{overall.reading}</Text>
            <Text color="subtle" wrap="truncate-end">
              {overall.detail}
            </Text>
          </Box>
          <Text color="subtle" wrap="truncate-end">
            {sessionStats}
          </Text>
        </Box>
        {tree.map(({ thread, depth }) => row(thread, depth))}
        {subagents.length === 0 ? (
          <Text key="hint" dimColor wrap="wrap">
            Subagents show up here as Claude starts them, each with its model, cost and progress.
          </Text>
        ) : null}
        {earlier.length === 0 ? null : (
          <Box key="earlier" flexDirection="column">
            <Text color="subtle">Earlier</Text>
            {earlier.map(earlierRow)}
          </Box>
        )}
        {subagents.some(isEnded) ? (
          <Box key="actions" flexDirection="row">
            <Button key="clear" label="Clear finished" onPress={() => void clearFinished($)} />
          </Box>
        ) : null}
      </Box>
    )
  })
}
