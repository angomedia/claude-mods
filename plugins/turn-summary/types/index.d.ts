// What a turn has done so far.
export type Tally = { tools: number; files: string[]; added: number; removed: number }

// A finished turn's line, found again by its duration when the terminal draws the turn's footer.
export type Summary = { durationMs: number; text: string }

declare module 'claude-code' {
  interface PluginState {
    'turn-summary': { isOn: boolean; tally: Tally | null; done: Summary[] }
  }
}
