export type Mode = 'light' | 'dark'

declare module 'claude-code' {
  interface PluginState {
    'imessage-chat': { mode: Mode; isOn: boolean; withImages: string[] }
  }
}
