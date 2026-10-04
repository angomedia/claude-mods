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

declare module 'claude-code' {
  interface PluginState {
    'session-hud': { snapshot: Snapshot | null; turn: TurnInfo; isOn: boolean }
  }
}
