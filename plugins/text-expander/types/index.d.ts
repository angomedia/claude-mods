export type Where = 'yours' | 'project'

// One snippets file as the window shows it: `shown` is its path with ~ for your home folder.
export type SnippetFileView = { where: Where; path: string; shown: string; snippets: Record<string, string>; error?: string }

// What's typed in the window's add row and not yet added. `form` counts adds, so each one draws
// fresh, empty fields.
export type Draft = { trigger: string; text: string }

declare module 'claude-code' {
  interface PluginState {
    'text-expander': { files: SnippetFileView[]; draft: Draft; form: number }
  }
}
