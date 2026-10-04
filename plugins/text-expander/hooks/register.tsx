import type { EngineInterface, Register } from 'claude-code'

type Snippets = Record<string, string>
type Where = 'yours' | 'project'
type SnippetFile = { where: Where; path: string; snippets: Snippets; error?: string }

// Written the first time the mod runs, so there's something to try and a file to copy from.
const STARTERS: Snippets = {
  ';;t': 'Run the tests and fix anything that fails. Tell me what you changed.',
  ';;e': "Explain this in plain language, as if I'm new to it. Keep it short.",
  ';;r': 'Review what you just changed for bugs and edge cases before we move on.',
  ';;s': "Summarize what you did, what you checked, and what's left, in a few bullets.",
  ';;p': 'Make a plan first and wait for my OK before changing any files.',
  ';;c': 'Commit these changes with a clear message.',
}

// Prompts the person sent; notifications and other agents' messages are left as they are.
const OWN_PROMPTS = new Set(['composer', 'bridge', 'sdk', 'scheduled-trigger'])

const paths = async ($: EngineInterface) => {
  const home = (await $.env.get('HOME')) ?? ''

  return { yours: `${home}/.claude/snippets.json`, project: `${await $.session.root()}/.claude/snippets.json`, home }
}

const tidy = (path: string, home: string) => (home !== '' && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path)

const readFile = async ($: EngineInterface, where: Where, path: string): Promise<SnippetFile> => {
  if (!(await $.fs.exists(path))) {
    return { where, path, snippets: {} }
  }

  try {
    const parsed: unknown = JSON.parse(await $.fs.read(path))

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { where, path, snippets: {}, error: 'it should be one object of "trigger": "text" pairs' }
    }

    const snippets = Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && /^\S+$/.test(entry[0])),
    )

    return { where, path, snippets }
  } catch (error) {
    return { where, path, snippets: {}, error: error instanceof Error ? error.message : String(error) }
  }
}

const readAll = async ($: EngineInterface) => {
  const where = await paths($)

  return { ...where, files: await Promise.all([readFile($, 'yours', where.yours), readFile($, 'project', where.project)]) }
}

const writeFile = ($: EngineInterface, path: string, snippets: Snippets) => $.fs.write(path, `${JSON.stringify(snippets, null, 2)}\n`)

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// A trigger expands where it stands as a word of its own: after a space or the start, before a
// space, the end, or punctuation.
const expand = (text: string, snippets: Snippets) => {
  const triggers = Object.keys(snippets).sort((a, b) => b.length - a.length)
  const used: string[] = []

  if (triggers.length === 0) {
    return { text, used }
  }

  const pattern = new RegExp(`(^|\\s)(${triggers.map(escapeRegExp).join('|')})(?=$|\\s|[.,!?:)\\]])`, 'g')
  const expanded = text.replace(pattern, (_match, lead: string, trigger: string) => {
    used.push(trigger)

    return `${lead}${snippets[trigger]}`
  })

  return { text: expanded, used }
}

const cell = (text: string, max = 70) => {
  const flat = text.replace(/\s+/g, ' ').replace(/\|/g, '\\|').replace(/`/g, "'")

  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

const table = (snippets: Snippets) =>
  ['| Type | To send |', '| --- | --- |', ...Object.entries(snippets).map(([trigger, text]) => `| \`${trigger}\` | ${cell(text)} |`)].join('\n')

const HELP = [
  '**Add one** for every project: `/snippets add ;;x what it expands to`',
  '**Add one** for this project only: `/snippets add-here ;;x what it expands to`',
  '**Remove one:** `/snippets remove ;;x`',
  '**Edit the file:** `/snippets edit` (yours) or `/snippets edit here` (this project)',
].join('\n')

const list = async ($: EngineInterface) => {
  const { files, home } = await readAll($)
  const sections = files.map(file => {
    const title =
      file.where === 'yours'
        ? `**Your snippets**, in every project · \`${tidy(file.path, home)}\``
        : `**This project's snippets** · \`${tidy(file.path, home)}\` (commit it to share them)`

    if (file.error !== undefined) {
      return `${title}\n\nThis file has a mistake, so none of its snippets work: ${file.error}`
    }

    return Object.keys(file.snippets).length === 0 ? `${title}\n\nNone yet.` : `${title}\n\n${table(file.snippets)}`
  })

  return [...sections, HELP].join('\n\n')
}

// Opens the file in the Mac's default text editor, creating it first if needed.
const edit = async ($: EngineInterface, where: Where) => {
  const all = await paths($)
  const path = where === 'yours' ? all.yours : all.project

  if (!(await $.fs.exists(path))) {
    await writeFile($, path, {})
  }

  try {
    await $.process.run(['/usr/bin/open', '-t', path], { timeoutMs: 10_000 })

    return `Opened \`${tidy(path, all.home)}\`. Changes work on your next message.`
  } catch {
    return `Edit \`${tidy(path, all.home)}\` in any text editor. Changes work on your next message.`
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'snippets',
      description: 'List, add or remove text snippets (type ;;t to send a whole prompt)',
      argumentHint: '[add|add-here|remove|edit]',
      immediate: true,
    })

    // Starter snippets, once: a file you delete stays deleted.
    const { yours } = await paths($)

    if ((await $.store.get('seeded')) !== true) {
      if (!(await $.fs.exists(yours))) {
        await writeFile($, yours, STARTERS)
      }

      await $.store.set('seeded', true)
    }

    return started
  })

  on('prompt.submit', async ($, e, next) => {
    if (!OWN_PROMPTS.has(e.origin.kind) || !/\S/.test(e.text)) {
      return next(e)
    }

    const { files } = await readAll($)
    // This project's snippets win over yours.
    const snippets = { ...files[0].snippets, ...files[1].snippets }
    const { text, used } = expand(e.text, snippets)

    if (used.length === 0) {
      return next(e)
    }

    $.ui.toast(`Expanded ${[...new Set(used)].join(', ')}`)

    return next({ ...e, text })
  })

  on('command.run', { command: 'snippets' }, async ($, e) => {
    const args = e.args.trim()
    const [word = '', trigger = ''] = args.split(/\s+/)
    const action = word.toLowerCase()
    const text = args.slice(word.length).trim().slice(trigger.length).trim()

    if (action === '' || action === 'list') {
      return { text: await list($) }
    }

    if (action === 'edit') {
      return { text: await edit($, trigger.toLowerCase() === 'here' ? 'project' : 'yours') }
    }

    const all = await paths($)

    if (action === 'add' || action === 'add-here') {
      if (trigger === '' || text === '') {
        return { text: `Give a trigger and what it expands to: \`/snippets ${action} ;;x your text\`` }
      }

      const file = await readFile($, action === 'add' ? 'yours' : 'project', action === 'add' ? all.yours : all.project)

      if (file.error !== undefined) {
        return { text: `\`${tidy(file.path, all.home)}\` has a mistake, so I left it alone: ${file.error}` }
      }

      const isUpdate = trigger in file.snippets
      await writeFile($, file.path, { ...file.snippets, [trigger]: text })

      return { text: `${isUpdate ? 'Updated' : 'Added'} \`${trigger}\`${action === 'add-here' ? ' for this project' : ''}. Type it in a message to send: ${cell(text, 200)}` }
    }

    if (action === 'remove' || action === 'delete') {
      const { files } = await readAll($)
      const holding = files.filter(file => file.error === undefined && trigger in file.snippets)

      if (holding.length === 0) {
        return { text: `There's no \`${trigger}\` snippet. \`/snippets\` lists them.` }
      }

      for (const file of holding) {
        const { [trigger]: _removed, ...rest } = file.snippets
        await writeFile($, file.path, rest)
      }

      return { text: `Removed \`${trigger}\`.` }
    }

    return { text: HELP }
  })
}
