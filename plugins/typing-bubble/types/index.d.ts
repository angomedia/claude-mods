export type Mode = 'light' | 'dark'

declare module 'claude-code' {
  interface PluginState {
    // `frame` steps the terminal's dots; the desktop's bubble animates itself.
    'typing-bubble': { mode: Mode; isOn: boolean; frame: number }
  }
}
