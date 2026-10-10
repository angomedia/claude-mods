// Where a thread stands. The main thread is `running` during a turn and `idle` between turns;
// a subagent ends `completed`, `failed` or `killed` (stopped).
export type ThreadStatus = 'pending' | 'running' | 'waiting' | 'idle' | 'completed' | 'failed' | 'killed'

// One step of a thread's task list, from its TodoWrite or TaskCreate/TaskUpdate calls.
export type PlanItem = { id: string; text: string; active?: string; status: 'pending' | 'in_progress' | 'completed' }

// The main thread (`id` "main") or one subagent.
export type Thread = {
  id: string
  // The thread that started it: "main", or another subagent's id. Absent on the main thread.
  parentId?: string
  title: string
  // The agent type (`Explore`, `general-purpose`, ...); "main" for the main thread.
  type: string
  model?: string
  effort?: string
  status: ThreadStatus
  // The main thread's turn it started in.
  turn: number
  startedAt: number
  // The main thread's current turn began at this time.
  turnStartedAt?: number
  endedAt?: number
  // Tool calls in all; `turnTools` counts the main thread's current turn alone.
  tools: number
  turnTools: number
  activity?: string
  plan: PlanItem[]
  // Estimated at list price from the thread's own token counts.
  costUsd: number
  // True once a request ran on a model with no known price, so `costUsd` is short.
  hasUnpriced: boolean
  // Input tokens of the thread's last request: its context size.
  contextTokens?: number
}

// The session's own figures, as session-hud reads them.
export type Overview = {
  costUsd?: number
  contextPercent?: number
  contextTokens?: number
  contextWindow: number
  startedAt: number
  // Now, rounded to the second while anything runs and to the minute otherwise, so the pane redraws no more than that.
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    'agent-threads': {
      threads: Thread[]
      overview: Overview | null
      isAuto: boolean
      hasAutoOpened: boolean
      mainTurn: number
      // Tool calls a thread of each type usually needs, from past sessions: what an estimated bar measures against.
      typical: Record<string, number>
    }
  }
}
