export type Where = 'yours' | 'project'

// One snippets file as the window shows it: `shown` is its path with ~ for your home folder.
export type SnippetFileView = { where: Where; path: string; shown: string; snippets: Record<string, string>; error?: string }

declare module 'claude-code' {
  interface PluginState {
    // `form` counts rows added from the window, so each add draws a fresh, empty field.
    'text-expander': { files: SnippetFileView[]; form: number }
  }
}
