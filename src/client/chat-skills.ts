export interface ChatSkill {
  id: string
  name: string
  revision: number
  description?: string
  projectId?: string
}

// Code examples and escaped dollars are literal text, not skill invocations.
function invocationText(text: string): string {
  return text.replace(/```[\s\S]*?(?:```|$)|`[^`\n]*(?:`|$)|\\\$/g, value => ' '.repeat(value.length))
}

export function skillMentions(text: string): { name: string; start: number; end: number }[] {
  return Array.from(invocationText(text).matchAll(/(?:^|[\s([{])\$([a-z][a-z0-9]*(?:-[a-z0-9]+)*)(?![\w-])/g), match => {
    const name = match[1]!
    const end = match.index + match[0].length
    return { name, start: end - name.length - 1, end }
  })
}

export function skillNames(text: string): string[] {
  return [...new Set(skillMentions(text).map(mention => mention.name))]
}

export function skillAtCaret(text: string, caret: number | null): { start: number; end: number; query: string } | null {
  if (caret === null) return null
  const prefix = invocationText(text).slice(0, caret)
  const match = /(?:^|[\s([{])\$([a-z0-9-]*)$/.exec(prefix)
  if (!match) return null
  const query = match[1]!
  return { start: caret - query.length - 1, end: caret + (text.slice(caret).match(/^[a-z0-9-]*/)?.[0].length ?? 0), query }
}

type LibraryCall = <T>(command: string, args?: Record<string, unknown>) => Promise<T>

/** Pin explicit $skills before sending, without reading their instructions. */
export async function bindPromptSkills(text: string, library: LibraryCall): Promise<void> {
  const names = skillNames(text)
  if (!names.length) return
  if (names.length > 8) throw new Error('Use at most eight skills per message.')
  const active = (await library<{ items: ChatSkill[] }>('active')).items
  const selected: ChatSkill[] = []
  for (const name of names) {
    const pinned = active.filter(item => item.name === name)
    const matches = pinned.length ? pinned : (await library<{ items: ChatSkill[] }>('list', { name, limit: 2 })).items
    if (!matches.length) throw new Error(`Skill $${name} was not found. Choose a skill or remove its $ mention.`)
    if (matches.length > 1) throw new Error(`Several skills use $${name}. Select one version in Manage skills and unload any duplicate selections.`)
    if (!pinned.length) selected.push(matches[0]!)
  }
  if (active.length + selected.length > 8) throw new Error('Unload a skill before selecting more than eight for this chat.')
  for (const skill of selected) await library('bind', { id: skill.id, revision: skill.revision })
}
