// One file Claude changed this session: `shown` is its path from the project root.
export type FileChange = { path: string; shown: string; edits: number; added: number; removed: number; isNew: boolean; at: number }

declare module 'claude-code' {
  interface PluginState {
    'files-changed': { files: FileChange[]; hasHinted: boolean }
  }
}
