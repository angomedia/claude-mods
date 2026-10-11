// One installed plugin, as the table shows it.
export type ModRow = {
  // `<name>@<marketplace>`, as `claude plugin enable` and `disable` take it.
  id: string
  name: string
  version?: string
  isEnabled: boolean
  // A few words: what it does.
  short: string
  // How to switch it off and on in a session, as Markdown.
  toggle: string
  // `installed` through a marketplace, or `dev`: loaded from a folder (this session's dev-mods
  // folder, CLAUDE_CODE_PLUGIN_DIRS) without being installed.
  source: 'installed' | 'dev'
  // An installed mod that a dev folder also holds a copy of.
  hasDevCopy: boolean
}

declare module 'claude-code' {
  interface PluginState {
    // `problem` is why part of the list couldn't be read, empty when all of it could.
    'mod-list': { mods: ModRow[]; problem: string }
  }
}
