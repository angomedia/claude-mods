export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export type Snapshot = {
  model: string
  contextTokens?: number
  contextWindow: number
  contextPercent?: number
  limits: Limit[]
  costUsd?: number
  startedAt: number
  at: number
}

export type TurnInfo = { model?: string; effort?: string }

// What the card's buttons are doing: nothing, waiting on a second press, or running.
export type Action = 'idle' | 'confirm' | 'compacting' | 'handoff'

declare module 'claude-code' {
  interface PluginState {
    'session-hud': { snapshot: Snapshot | null; turn: TurnInfo; isOn: boolean; action: Action }
  }
}
