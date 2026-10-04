// How many screenshots `/ss` set to go with the next message; 0 when none.
export type Pending = number

declare module 'claude-code' {
  interface PluginState {
    'screenshot-attach': { pending: Pending }
  }
}
