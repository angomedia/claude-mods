export type Mode = 'light' | 'dark'

export type ReplyColor = 'blue' | 'gray'

declare module 'claude-code' {
  interface PluginState {
    'imessage-chat': { mode: Mode; isOn: boolean; withImages: string[]; replyColor: ReplyColor }
  }
}
