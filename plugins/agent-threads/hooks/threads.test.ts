import { expect, mock, test } from 'claude-code/testing'

const pane = { title: 'Threads', isFocused: false, bodyColumns: 52, placement: 'dock', scroll: {}, view: {} } as any
const HAIKU = 'claude-haiku-4-5-20251001'
const OPUS = 'claude-opus-5-5[1m]'

const usage = {
  startedAt: Date.now() - 10 * 60_000,
  context: { tokens: 120_000, window: 1_000_000, percent: 12 },
  rateLimits: [],
  cost: { usd: 3.5 },
}

// One request's tokens: on Haiku 4.5 that is $0.0335 (1k input, 10k cache write, 100k cache read, 2k output).
const STEP_TOKENS = { input_tokens: 1_000, output_tokens: 2_000, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 10_000 }

const setup = async ($: any, on: any, store: Record<string, unknown> = {}) => {
  const opened: string[] = []
  const toasts: string[] = []
  let isPlaced = true
  mock.clock(on, { now: Date.now() })
  mock.store(on, store)
  on('session.usage', () => ({ value: usage }) as any)
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }) as any)
  on('agent.list', () => ({ value: [] }) as any)
  on('ui.panes', () => ({ value: opened.map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })) }) as any)
  on('ui.open', (_$: unknown, e: { id: string }) => {
    if (isPlaced) {
      opened.push(e.id)
    }
    return { value: isPlaced ? { isPlaced: true } : { isPlaced: false, reason: 'narrow' } } as any
  })
  on('ui.close', (_$: unknown, e: { id: string }) => {
    opened.splice(opened.indexOf(e.id), 1)
    return { value: undefined } as any
  })
  on('ui.toast', (_$: unknown, e: { text: string }) => {
    toasts.push(e.text)
    return { value: undefined } as any
  })
  on('agent.spawn', (_$: unknown, e: { description: string }) => ({ model: HAIKU, agentId: `agent-${e.description.replace(/ /g, '-')}` }))
  on('turn.start', (_$: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', (_$: unknown, e: { answer: string }) => ({ text: e.answer }))
  on('turn.step', async function* (_$: unknown, e: { turnId: string; index: number; model: string }) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: { model: e.model.replace(/\[.*\]/, ''), ...STEP_TOKENS } }
  } as any)
  on('tool.call', (_$: unknown, e: { tool: string; subject?: string }) =>
    e.tool === 'TaskCreate' ? { result: { task: { id: e.subject, subject: e.subject } } } : { result: {} },
  )
  on('ui.render', () => ({ type: 'engine', ref: 1 }) as const)
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })

  return { opened, toasts, narrow: () => (isPlaced = false) }
}

const startTurn = ($: any, turnId = 't1') => $.turn.start({ text: 'go', turnId })

const spawn = ($: any, description: string, subagentType = 'Explore') =>
  $.agent.spawn({
    tool_use_id: `call-${description}`,
    prompt: 'Look around.',
    description,
    subagentType,
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: OPUS,
    background: false,
    fork: false,
  })

const step = async ($: any, model: string, agentId?: string) => {
  const stream = $.turn.step({ turnId: 't1', index: 0, model, messageCount: 3, ...(agentId === undefined ? {} : { agentId }) })
  for await (const _chunk of stream) {
    // Drained: the step's result is what the hook records.
  }
  return stream.result
}

const finish = ($: any, agentId?: string, reason = 'answer') =>
  $.turn.complete({ answer: 'done', durationMs: 1_000, isAborted: reason === 'aborted', turnId: 't1', reason, ...(agentId === undefined ? {} : { agentId }) })

const draw = async ($: any, surface: 'desktop' | 'terminal' = 'desktop') => {
  const ui = await $.ui.mount({ plugin: 'agent-threads', surface, component: 'Pane', requestId: 'agent-threads', props: pane })
  const drawn = JSON.stringify(await ui.drawn())
  await ui.unmount()
  return drawn
}

for (const surface of ['desktop', 'terminal'] as const) {
  test(`shows the main thread and a subagent with its model, cost and progress on the ${surface}`, async ($, on) => {
    await setup($, on)
    await startTurn($)
    await step($, OPUS)
    await spawn($, 'Explore auth flow')
    await step($, HAIKU, 'agent-Explore-auth-flow')

    const running = await draw($, surface)
    expect(running).toContain('Main thread')
    expect(running).toContain('Opus 5.5 1M')
    expect(running).toContain('Explore auth flow')
    expect(running).toContain('Haiku 4.5')
    expect(running).toContain('≈ $0.03')
    expect(running).toContain('111k context')
    expect(running).toContain('0 of 1 agent done')
    expect(running).toContain('API ≈ $3.50')

    await finish($, 'agent-Explore-auth-flow')
    const done = await draw($, surface)
    expect(done).toContain('100%')
    expect(done).toContain('1 of 1 agent done')
    expect(done).toContain('"label":"Clear finished"')
  })
}

test('the main thread share is the exact total less the subagents', async ($, on) => {
  await setup($, on)
  await startTurn($)
  await spawn($, 'Explore auth flow')
  await step($, HAIKU, 'agent-Explore-auth-flow')

  // $3.50 in all, $0.0335 of it the subagent's.
  expect(await draw($)).toContain('≈ $3.47')
})

test('a task list gives the main thread a real bar', async ($, on) => {
  await setup($, on)
  await startTurn($)
  await $.tool.call({
    tool: 'TodoWrite',
    tool_use_id: 'todo',
    todos: [
      { content: 'Read the code', status: 'completed', activeForm: 'Reading the code' },
      { content: 'Write the mod', status: 'in_progress', activeForm: 'Writing the mod' },
      { content: 'Test it', status: 'pending', activeForm: 'Testing it' },
    ],
  } as any)

  const drawn = await draw($)
  expect(drawn).toContain('1 of 3 steps')
  expect(drawn).toContain('33%')
})

test('TaskCreate and TaskUpdate build the task list too', async ($, on) => {
  await setup($, on)
  await startTurn($)
  await $.tool.call({ tool: 'TaskCreate', tool_use_id: 'c1', subject: 'one', description: 'first' } as any)
  await $.tool.call({ tool: 'TaskCreate', tool_use_id: 'c2', subject: 'two', description: 'second' } as any)
  await $.tool.call({ tool: 'TaskUpdate', tool_use_id: 'u1', taskId: 'one', status: 'completed' } as any)

  expect(await draw($)).toContain('1 of 2 steps')
})

test('without a task list, the bar is estimated from how many tools this kind of thread usually takes', async ($, on) => {
  await setup($, on, { history: { main: [10, 10, 10] } })
  await startTurn($)

  for (const id of ['r1', 'r2', 'r3', 'r4', 'r5']) {
    await $.tool.call({ tool: 'Read', tool_use_id: id, file_path: `/work/${id}.ts` } as any)
  }

  const drawn = await draw($)
  expect(drawn).toContain('5 of ~10 tools')
  expect(drawn).toContain('~45%')
  expect(drawn).toContain('Reading r5.ts')
})

test('a finished run teaches the estimate for its type', async ($, on) => {
  await setup($, on)
  await startTurn($)
  await spawn($, 'Explore auth flow')
  await finish($, 'agent-Explore-auth-flow')
  await finish($)
  await startTurn($, 't2')
  await spawn($, 'Explore rules')
  await step($, HAIKU, 'agent-Explore-rules')

  // One finished Explore run with no tools: the floor of 4 is the measure until there are more.
  expect(await draw($)).toContain('0 of ~4 tools')
})

test('failed and stopped subagents say so', async ($, on) => {
  await setup($, on)
  await startTurn($)
  await spawn($, 'Explore auth flow')
  await spawn($, 'Review rules', 'general-purpose')
  await finish($, 'agent-Explore-auth-flow', 'error')
  await finish($, 'agent-Review-rules', 'aborted')

  const drawn = await draw($)
  expect(drawn).toContain('Failed')
  expect(drawn).toContain('Stopped')
})

test('subagents of earlier turns move to Earlier, and Overall counts this turn', async ($, on) => {
  await setup($, on)
  await startTurn($)
  await spawn($, 'Explore auth flow')
  await finish($, 'agent-Explore-auth-flow')
  await finish($)
  await startTurn($, 't2')
  await spawn($, 'Review rules', 'general-purpose')

  const drawn = await draw($)
  expect(drawn).toContain('Earlier')
  expect(drawn).toContain('0 of 1 agent done')
})

test('the first subagent opens the pane once; /threads toggles it', async ($, on) => {
  const { opened } = await setup($, on)
  await startTurn($)
  await spawn($, 'Explore auth flow')
  expect(opened).toEqual(['agent-threads'])

  await $.command.run({ command: 'threads', args: '' } as any)
  expect(opened).toEqual([])

  // Closed by the person: a later subagent leaves it closed.
  await spawn($, 'Review rules', 'general-purpose')
  expect(opened).toEqual([])

  await $.command.run({ command: 'threads', args: '' } as any)
  expect(opened).toEqual(['agent-threads'])
})

test('/threads auto off keeps it closed until asked', async ($, on) => {
  const { opened } = await setup($, on)
  await $.command.run({ command: 'threads', args: 'auto off' } as any)
  await startTurn($)
  await spawn($, 'Explore auth flow')

  expect(opened).toEqual([])
})

test('a terminal too narrow to seat the pane gets a pointer to /threads', async ($, on) => {
  const { toasts, narrow } = await setup($, on)
  narrow()
  await startTurn($)
  await spawn($, 'Explore auth flow')

  expect(toasts).toEqual(['Subagents are running. /threads shows each one with its progress.'])
})

test('/threads clear drops the finished subagents', async ($, on) => {
  await setup($, on)
  await startTurn($)
  await spawn($, 'Explore auth flow')
  await spawn($, 'Review rules', 'general-purpose')
  await finish($, 'agent-Explore-auth-flow')
  await $.command.run({ command: 'threads', args: 'clear' } as any)

  const drawn = await draw($)
  expect(drawn).not.toContain('Explore auth flow')
  expect(drawn).toContain('Review rules')
})

test('with no subagents yet, it says where they will show up', async ($, on) => {
  await setup($, on)

  expect(await draw($)).toContain('Subagents show up here as Claude starts them')
})

test("a subagent's tool calls count toward it, not the main thread", async ($, on) => {
  await setup($, on)
  await startTurn($)
  await spawn($, 'Explore auth flow')
  await $.tool.call({ tool: 'Read', tool_use_id: 'r1', file_path: '/work/auth.ts', agentId: 'agent-Explore-auth-flow' } as any)

  const drawn = await draw($)
  expect(drawn).toContain('1 of ~15 tools')
  expect(drawn).toContain('Reading auth.ts')
  expect(drawn).toContain('0 of ~8 tools')
})
