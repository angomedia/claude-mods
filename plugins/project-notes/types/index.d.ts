// This project's notes file and its lines, as last read or written. `draft` counts the notes
// added from the pane, so each one draws a fresh, empty field.
export type Notes = { path: string; project: string; lines: string[] }

declare module 'claude-code' {
  interface PluginState {
    'project-notes': { notes: Notes | null; draft: number }
  }
}
