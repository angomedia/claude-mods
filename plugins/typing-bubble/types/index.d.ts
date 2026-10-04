export type Mode = 'light' | 'dark'

declare module 'claude-code' {
  interface PluginState {
    // `frame` steps the terminal's dots; the desktop's bubble animates itself.
    // `doing` is the running tool's caption on the desktop, empty between tools.
    'typing-bubble': { mode: Mode; isOn: boolean; frame: number; doing: string }
  }
}
