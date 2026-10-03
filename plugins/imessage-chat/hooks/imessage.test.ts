import { expect, test } from 'claude-code/testing'

const prompt = (text: string) => ({ text, origin: { kind: 'composer' }, isExpanded: false }) as const

test('draws your message as an SVG bubble on the desktop', async $ => {
  const ui = await $.ui.mount({ plugin: 'imessage-chat', surface: 'desktop', component: 'UserMessage', props: prompt('hello <there> & "you"') })
  const drawn = JSON.stringify(await ui.drawn())

  expect(drawn).toContain('"type":"Svg"')
  expect(drawn).toContain('hello &lt;there&gt; &amp; &quot;you&quot;')
})

test('falls back to a box bubble in the terminal', async $ => {
  const ui = await $.ui.mount({ plugin: 'imessage-chat', surface: 'terminal', component: 'UserMessage', props: prompt('hello') })

  expect(JSON.stringify(await ui.drawn())).toContain('"borderStyle":"round"')
})

test("draws Claude's reply as a gray box with markdown", async $ => {
  const ui = await $.ui.mount({ plugin: 'imessage-chat', surface: 'desktop', component: 'AssistantMessage', props: { text: '**hi** there', isFirstOfReply: true } })

  expect(JSON.stringify(await ui.drawn())).toContain('"type":"Markdown"')
})

test('wraps a long message onto several lines', async $ => {
  const ui = await $.ui.mount({ plugin: 'imessage-chat', surface: 'desktop', component: 'UserMessage', props: prompt('word '.repeat(200)) })
  const drawn = JSON.stringify(await ui.drawn())

  expect((drawn.match(/<text /g) ?? []).length > 5).toBe(true)
})

test('keeps the app drawing above the bubble when the prompt had images', async ($, on) => {
  on('prompt.submit', ($, e) => ({ text: e.text }))
  // Stands in for the app's own drawing of the row.
  on('ui.render', () => ({ type: 'engine', ref: 1 }) as const)
  await $.prompt.submit({ text: 'look at this', attachments: [{ type: 'image', mediaType: 'image/png' }], wait: false, origin: { kind: 'composer' } } as any)
  const ui = await $.ui.mount({ plugin: 'imessage-chat', surface: 'desktop', component: 'UserMessage', props: prompt('look at this') })
  const drawn = JSON.stringify(await ui.drawn())

  expect(drawn).toContain('"type":"engine"')
  expect(drawn).toContain('"type":"Svg"')
})

test('draws only the bubble when the prompt had no images', async $ => {
  const ui = await $.ui.mount({ plugin: 'imessage-chat', surface: 'desktop', component: 'UserMessage', props: prompt('no pictures here') })

  expect(JSON.stringify(await ui.drawn())).not.toContain('"type":"engine"')
})
