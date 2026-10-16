/**
 * Claude Code's release notes for the person: the changelog's sections for the installed
 * version (or for every version since it, when a newer one is out), the prompt that asks for the
 * changes worth knowing, and the picks read back from the reply. Pure: the Hub fetches the
 * changelog and asks the model.
 */
import type { HudReleaseSection } from '../types'
import { compareVersions } from './lib'

/** Claude Code's changelog: one `## <version>` heading per release, newest first, its changes as `-` bullets. */
export const CHANGELOG_URL = 'https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md'

/** The most changelog text sent to the model, so a long run of versions cannot make the request huge. */
const MAX_NOTES_CHARS = 60_000

/** The most picks kept for one version. */
const MAX_PICKS = 6

/** One release's section of the changelog: its version and its text, the bullets under the heading. */
export type ChangelogSection = { version: string; body: string }

/**
 * What the notes are for: the installed version alone, or `<installed> → <latest>` when a newer
 * one is out. Also the key the picks are kept under.
 * `releaseRange('2.1.296', '2.1.300')` → `'2.1.296 → 2.1.300'`.
 */
export function releaseRange(installed: string, latest: string): string {
  return latest !== '' && compareVersions(latest, installed) > 0 ? `${installed} → ${latest}` : installed
}

/**
 * The changelog's sections for `installed`, or, when `latest` is newer, for every version after
 * `installed` up to `latest` (the ones an update would bring), newest first as the changelog
 * lists them. A heading's version may carry a `v` and anything after a space (a date).
 */
export function changelogSections(markdown: string, installed: string, latest: string): ChangelogSection[] {
  const isUpdate = latest !== '' && compareVersions(latest, installed) > 0
  const wanted = (version: string) =>
    isUpdate ? compareVersions(version, installed) > 0 && compareVersions(version, latest) <= 0 : compareVersions(version, installed) === 0
  const sections: ChangelogSection[] = []
  let current: { version: string; lines: string[] } | undefined
  const close = () => {
    if (current !== undefined && wanted(current.version)) sections.push({ version: current.version, body: current.lines.join('\n').trim() })
  }
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^##\s+v?(\d+(?:\.\d+)+)/.exec(line)
    if (heading !== null) {
      close()
      current = { version: heading[1]!, lines: [] }
    } else if (current !== undefined) {
      current.lines.push(line)
    }
  }
  close()
  return sections
}

/**
 * The question for the model: the sections' notes (cut to `MAX_NOTES_CHARS`), and a request for
 * only the changes this person would care about, by what it knows of them and their session,
 * as a `## <version>` heading and `- ` lines per version that has any, or `## none`.
 */
export function releaseNotesPrompt(sections: readonly ChangelogSection[]): string {
  const notes = sections
    .map(s => `## ${s.version}\n${s.body}`)
    .join('\n\n')
    .slice(0, MAX_NOTES_CHARS)
  return [
    "Below are Claude Code's release notes. From what you know of me and of this session (what I",
    'work on, the tools, platform and features I use), pick only the changes I would want to know',
    'about: ones that change how I work, fix something I am likely to hit, or are worth trying.',
    'Leave out internal fixes and anything for a platform or feature I do not use.',
    '',
    'Answer with nothing else: for each version that has something worth it, newest first, a line',
    `"## <version>", then up to ${MAX_PICKS} lines "- <the change, in a few plain words>". Leave out a`,
    'version with nothing for me. If nothing at all is worth it, answer only "## none".',
    '',
    '<release-notes>',
    notes,
    '</release-notes>',
  ].join('\n')
}

/**
 * The picks in a reply to `releaseNotesPrompt`: a section per `## <version>` heading with its
 * `- ` or `* ` lines (up to `MAX_PICKS`), in the reply's order. A heading without picks, `## none`,
 * and any other line are left out, so a reply that found nothing gives no sections.
 */
export function parseReleasePicks(reply: string): HudReleaseSection[] {
  const sections: HudReleaseSection[] = []
  let current: HudReleaseSection | undefined
  for (const line of reply.split(/\r?\n/)) {
    const heading = /^#+\s*v?(\d+(?:\.\d+)+)/.exec(line.trim())
    if (heading !== null) {
      current = { version: heading[1]!, items: [] }
      sections.push(current)
      continue
    }
    if (/^#/.test(line.trim())) {
      current = undefined
      continue
    }
    const pick = /^[-*•]\s+(.+)$/.exec(line.trim())
    if (pick !== null && current !== undefined && current.items.length < MAX_PICKS) current.items.push(pick[1]!.trim())
  }
  return sections.filter(s => s.items.length > 0)
}
