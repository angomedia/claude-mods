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
