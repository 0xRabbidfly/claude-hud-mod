import { expect, mock, test } from 'claude-code/testing'

import { COMPACT_BRIEF, MAX_KEEP_ITEMS, RECHECK_NOTE, draftPrompt, keepListFile, keepListInstructions, parseKeepList, recheckNote } from '../hooks/compact'

test('the drafted reply becomes a short list: bullets or numbers, deduplicated, five at most', () => {
  const reply = ['Here is the list:', '- Decision: use **REST**, not gh', '* path lib/a.ts', '2) Decision: use REST, not gh', '- path lib/a.ts', ''].join('\n')
  expect(parseKeepList(reply)).toEqual([
    { text: 'Decision: use REST, not gh', keep: true },
    { text: 'path lib/a.ts', keep: true },
  ])
  const many = Array.from({ length: 30 }, (_, i) => `- item ${i}`).join('\n')
  expect(parseKeepList(many)).toHaveLength(MAX_KEEP_ITEMS)
  expect(MAX_KEEP_ITEMS).toBe(5)
})

test("the person's own words lead the draft prompt and the instructions", () => {
  expect(draftPrompt()).not.toContain('matters most')
  expect(draftPrompt('  the Azure deploy order  ')).toStartWith('The user says this matters most: the Azure deploy order')
  expect(draftPrompt('')).toBe(draftPrompt())
  expect(keepListInstructions(['a', 'b'], '/k.md')).toBe('Keep these, verbatim where possible:\n- a\n- b\nThe full list is also saved at /k.md.')
  expect(keepListInstructions(['a'], undefined, 'deploy order')).toBe(
    "In the user's own words, this matters most: deploy order\nKeep these, verbatim where possible:\n- a",
  )
  // Their words alone are enough to compact on, with nothing ticked.
  expect(keepListInstructions([], undefined, 'deploy order')).toBe("In the user's own words, this matters most: deploy order")
  expect(keepListFile(['a'], 's1', '2026-10-04T00:00:00.000Z', 'deploy order')).toContain("**In the user's words:** deploy order")
  expect(recheckNote()).toBe(RECHECK_NOTE)
  expect(recheckNote('/k.md')).toContain('/k.md')
})

const DIALOG = {
  title: 'Prep compact',
  isFocused: true,
  bodyColumns: 60,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
} as const

test('Prep compact: steer in your own words, untick one, compact with exactly that', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-04T12:00:00.000Z') })
  mock.env(on, { USERPROFILE: 'C:/Users/me' })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.id', () => ({ value: 'sess-1' }))
  const asked: string[] = []
  on('model.fork', (_$, e) => {
    asked.push(e.prompt)
    const text = asked.length === 1
      ? '- We are rewriting the Cache tab around cost\n- The HUD loads from the marketplace copy, not the checkout'
      : '- We are rewriting the Cache tab around cost\n- Deploy the portal before the gateway, always'
    return { value: { isAnswered: true, text, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }
  })
  const written: Record<string, string> = {}
  on('fs.write', (_$, e) => {
    written[e.path] = e.text
    return { value: undefined }
  })
  let compactedWith = ''
  on('session.compact', (_$, e) => {
    compactedWith = e.instructions ?? ''
    return { messages: [{ role: 'user' as const, text: 'summary', toolUses: [] }], tokensBefore: 300_000, tokensAfter: 30_000 }
  })

  const ui = await $.ui.mount({ plugin: 'session-hud', surface: 'terminal', component: 'Pane', requestId: 'hud-compact', props: DIALOG })
  // An empty submit is just "draft it": the first list has no steer behind it.
  await ui.input({ key: 'steer', text: '' })
  expect(asked[0]).not.toContain('matters most')
  expect(await ui.find({ type: 'Text', text: /marketplace copy/ })).toBeDefined()

  // Typing steers the next draft and is shown back as the person's own words.
  await ui.input({ key: 'steer', text: 'the deploy order' })
  expect(asked[1]).toStartWith('The user says this matters most: the deploy order')
  expect(await ui.find({ type: 'Text', text: 'the deploy order' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /marketplace copy/ })).toBeUndefined()

  await ui.press({ key: 'item-0' }) // untick the Cache tab line
  await ui.press({ key: 'compact-now' })

  expect(compactedWith.startsWith("The user asked specifically: In the user's own words, this matters most: the deploy order")).toBe(true)
  expect(compactedWith).toContain('- Deploy the portal before the gateway, always')
  expect(compactedWith).not.toContain('Cache tab')
  expect(compactedWith).toContain(COMPACT_BRIEF)

  const paths = Object.keys(written)
  expect(paths).toHaveLength(1)
  const unix = (p: string) => p.split(String.fromCharCode(92)).join('/')
  expect(unix(paths[0]!)).toBe('C:/Users/me/.claude/session-hud/keep/sess-1-2026-10-04T12-00-00-000Z.md')
  expect(written[paths[0]!]).toContain("**In the user's words:** the deploy order")
  expect(unix(compactedWith)).toContain(unix(paths[0]!))
  await ui.unmount()
})

test('Prep compact says so when there is nothing to summarise yet', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('model.fork', () => ({ value: { isAnswered: false, reason: 'nothing-to-fork' } }))
  const ui = await $.ui.mount({ plugin: 'session-hud', surface: 'terminal', component: 'Pane', requestId: 'hud-compact', props: DIALOG })
  await ui.input({ key: 'steer', text: '' })
  expect(await ui.find({ type: 'Text', text: /nothing to summarise yet/ })).toBeDefined()
  await ui.unmount()
})
