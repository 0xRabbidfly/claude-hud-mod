import { expect, test } from 'claude-code/testing'

import { CHANGELOG_URL, changelogSections, parseReleasePicks, releaseNotesPrompt, releaseRange } from '../hooks/release'

const CHANGELOG = [
  '# Changelog',
  '',
  '## 2.1.300',
  '',
  '- Plugins can draw a sidebar',
  '- Faster startup',
  '',
  '## v2.1.299 (2026-10-08)',
  '- Fix: Windows paths with spaces',
  '',
  '## 2.1.297',
  '- Bash keeps its working directory',
  '',
  '## 2.1.296',
  '- autoCompactWindow per model',
  '',
  '## 2.1.295',
  '- Older change',
].join('\n')

test('the notes are for the installed version, or every one an update would bring', () => {
  expect(releaseRange('2.1.296', '2.1.300')).toBe('2.1.296 → 2.1.300')
  expect(releaseRange('2.1.296', '2.1.296')).toBe('2.1.296')
  expect(releaseRange('2.1.300', '2.1.296')).toBe('2.1.300')
  expect(releaseRange('2.1.296', '')).toBe('2.1.296')

  // up to date: the installed version's own section
  expect(changelogSections(CHANGELOG, '2.1.296', '')).toEqual([{ version: '2.1.296', body: '- autoCompactWindow per model' }])
  // a newer one out: every version after the installed one, up to it, newest first; a v and a date are read past
  expect(changelogSections(CHANGELOG, '2.1.296', '2.1.299').map(s => s.version)).toEqual(['2.1.299', '2.1.297'])
  expect(changelogSections(CHANGELOG, '2.1.296', '2.1.300').map(s => s.version)).toEqual(['2.1.300', '2.1.299', '2.1.297'])
  expect(changelogSections(CHANGELOG, '2.1.296', '2.1.300')[0]?.body).toBe('- Plugins can draw a sidebar\n- Faster startup')
  // a version the changelog does not list yet has no section
  expect(changelogSections(CHANGELOG, '2.1.298', '')).toEqual([])
  expect(changelogSections('', '2.1.296', '2.1.300')).toEqual([])
  expect(CHANGELOG_URL).toMatch(/^https:\/\/.+CHANGELOG\.md$/)
})

test('the prompt carries the notes, asks for what matters to this person, and says how to answer', () => {
  const prompt = releaseNotesPrompt(changelogSections(CHANGELOG, '2.1.296', '2.1.300'))
  expect(prompt).toContain('## 2.1.300\n- Plugins can draw a sidebar')
  expect(prompt).toContain('## 2.1.297\n- Bash keeps its working directory')
  expect(prompt).toContain('From what you know of me')
  expect(prompt).toContain('## none')
  // a long run of versions is cut, so the request stays a sane size
  const huge = releaseNotesPrompt([{ version: '9.9.9', body: 'x'.repeat(100_000) }])
  expect(huge.length).toBeLessThan(62_000)
})

test('the picks are read back by version, six at most each, and a reply that found nothing gives none', () => {
  const reply = [
    'Here is what matters:',
    '## 2.1.300',
    '- Plugins can draw a sidebar: your HUD can use it',
    '* Faster startup',
    'not a pick',
    '### v2.1.297',
    '• Bash keeps its working directory',
    '## 2.1.299',
    '## Notes',
    '- a line under a heading that is no version',
  ].join('\n')
  expect(parseReleasePicks(reply)).toEqual([
    { version: '2.1.300', items: ['Plugins can draw a sidebar: your HUD can use it', 'Faster startup'] },
    { version: '2.1.297', items: ['Bash keeps its working directory'] },
  ])
  expect(parseReleasePicks('## none')).toEqual([])
  expect(parseReleasePicks('- a pick before any version')).toEqual([])
  const many = ['## 1.0.0', ...Array.from({ length: 9 }, (_, i) => `- pick ${i}`)].join('\n')
  expect(parseReleasePicks(many)[0]?.items).toHaveLength(6)
})

const META = {
  cwd: 'C:/x',
  id: '',
  name: '',
  model: '',
  effort: '',
  version: '2.1.296',
  latest: '2.1.300',
  hudVersion: '',
  committedAt: 0,
  startedAt: 0,
  turns: 0,
  minute: 0,
}
const SIDEBAR = { isFullscreen: true, bodyColumns: 40, columns: 200, isFocused: false } as never
const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

test("clicking Claude's version turns the sidebar to what is new since it, picked by a fork of the conversation, and keeps the picks", async ($, on) => {
  on('state.get', ($, e, next) => (e.key === 'meta' ? { value: { value: META, version: 1 } } : next(e)))
  const opened: string[] = []
  on('ui.open', (_$, e) => {
    opened.push(`${e.id}: ${e.title}`)
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => ({ value: undefined }))
  const store: Record<string, unknown> = {}
  on('store.get', (_, e) => ({ value: store[e.key] }))
  on('store.set', (_, e) => {
    store[e.key] = e.value
    return { value: undefined }
  })
  const fetched: string[] = []
  on('http.fetch', (_$, e) => {
    fetched.push(e.url)
    return { value: { ok: true, status: 200, headers: {}, text: CHANGELOG } }
  })
  const asked: string[] = []
  on('model.fork', (_$, e) => {
    asked.push(e.prompt)
    return { value: { isAnswered: true, text: '## 2.1.300\n- Plugins can draw a sidebar\n## 2.1.297\n- Bash keeps its directory', usage: USAGE } }
  })

  const sidebar = await $.ui.mount({ plugin: 'session-hud', surface: 'terminal', component: 'Pane', requestId: 'session-hud', props: SIDEBAR })
  await sidebar.press({ key: 'claude-version' })
  // the sidebar's own view, not a pane of its own that would open behind it
  expect(opened).toEqual(['session-hud: Session'])
  expect(fetched).toEqual([CHANGELOG_URL])
  // the fork reads only the versions an update would bring
  expect(asked[0]).toContain('## 2.1.299')
  expect(asked[0]).not.toContain('## 2.1.296')

  expect(await sidebar.find({ type: 'Text', text: 'What an update to 2.1.300 brings' })).toBeDefined()
  expect(await sidebar.find({ type: 'Text', text: '• Plugins can draw a sidebar' })).toBeDefined()
  expect(await sidebar.find({ type: 'Text', text: '• Bash keeps its directory' })).toBeDefined()

  // Back returns to the Hub, where the newer version also opens the same picks, without reading again
  await sidebar.press({ key: 'release-back' })
  expect(await sidebar.find({ type: 'Text', text: 'What an update to 2.1.300 brings' })).toBeUndefined()
  await sidebar.press({ key: 'claude-latest' })
  expect(await sidebar.find({ type: 'Text', text: '• Plugins can draw a sidebar' })).toBeDefined()
  expect(asked).toHaveLength(1)
  // Read again does read again
  await sidebar.press({ key: 'release-again' })
  expect(asked).toHaveLength(2)
  // the picks are kept for every session
  expect(store.releaseNotes).toEqual({
    versions: '2.1.296 → 2.1.300',
    sections: [
      { version: '2.1.300', items: ['Plugins can draw a sidebar'] },
      { version: '2.1.297', items: ['Bash keeps its directory'] },
    ],
  })
  await sidebar.unmount()
})

test('the release notes say why when they cannot be read, and ask without the conversation before there is one', async ($, on) => {
  const meta = { ...META, latest: '' }
  on('state.get', ($, e, next) => (e.key === 'meta' ? { value: { value: meta, version: 1 } } : next(e)))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('store.get', () => ({ value: { versions: 'junk' } }))
  on('store.set', () => ({ value: undefined }))
  let changelog: { ok: boolean; status: number; text: string } | 'offline' = { ok: false, status: 404, text: '' }
  on('http.fetch', () => {
    if (changelog === 'offline') throw new Error('getaddrinfo ENOTFOUND raw.githubusercontent.com')
    return { value: { ...changelog, headers: {} } }
  })
  on('model.fork', () => ({ value: { isAnswered: false, reason: 'nothing-to-fork' } }))
  const completed: string[] = []
  let completion: object = { isAnswered: true, text: '## none', usage: USAGE }
  on('model.complete', (_$, e) => {
    completed.push(e.model)
    return { value: completion as never }
  })
  const sidebar = await $.ui.mount({ plugin: 'session-hud', surface: 'terminal', component: 'Pane', requestId: 'session-hud', props: SIDEBAR })
  const again = async () => sidebar.press({ key: 'release-again' })

  await sidebar.press({ key: 'claude-version' })
  expect(await sidebar.find({ type: 'Text', text: "What's new in 2.1.296" })).toBeDefined()
  expect(await sidebar.find({ type: 'Text', text: 'the changelog did not load (HTTP 404)' })).toBeDefined()

  changelog = { ok: true, status: 200, text: '## 2.1.300\n- later' }
  await again()
  expect(await sidebar.find({ type: 'Text', text: 'the changelog has no notes for 2.1.296 yet' })).toBeDefined()

  // no conversation to fork yet: the model is asked without it, and found nothing that matters
  changelog = { ok: true, status: 200, text: CHANGELOG }
  await again()
  expect(completed).toEqual(['haiku'])
  expect(await sidebar.find({ type: 'Text', text: 'Nothing in these notes looks like it matters to you.' })).toBeDefined()

  completion = { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: USAGE }
  await again()
  expect(await sidebar.find({ type: 'Text', text: 'the notes could not be read (api-error)' })).toBeDefined()

  // offline: the fetch throws, and the screen says what went wrong rather than reading for ever
  changelog = 'offline'
  await again()
  expect(await sidebar.find({ type: 'Text', text: /fetch|ENOTFOUND/ })).toBeDefined()
  expect(await sidebar.find({ type: 'Text', text: /^Reading the release notes/ })).toBeUndefined()

  // Back leaves the view for the Hub
  await sidebar.press({ key: 'release-back' })
  expect(await sidebar.find({ type: 'Text', text: "What's new in 2.1.296" })).toBeUndefined()
  await sidebar.unmount()
})
