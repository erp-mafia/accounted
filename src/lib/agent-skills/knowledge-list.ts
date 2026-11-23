import type { KnowledgeOption } from './knowledge-choices'

/**
 * The catalogue's knowledge list: the knowledge items the product ships.
 * What the community shared and what the company wrote itself are listed in
 * their own places, so they are left out here.
 *
 * One definition for the Kunskap kind of the catalogue, the agent picture's
 * Kunskap folders and the number on the picture's card, so the three agree.
 *
 * Pure and browser-safe.
 */
export function catalogueKnowledge<T extends { tier: KnowledgeOption['tier'] }>(options: readonly T[]): T[] {
  return options.filter((option) => option.tier !== 'community' && option.tier !== 'own')
}

/**
 * What a company has chosen beyond the general items: the industry and
 * company-form items its profile names (agent_profiles.vertical_atoms and
 * modifier_atoms) and the items it installed (company_skills rows that point
 * at an item).
 */
export function chosenKnowledge(
  profile: { vertical_atoms?: readonly string[] | null; modifier_atoms?: readonly string[] | null } | null | undefined,
  installed: ReadonlyArray<{ atom_id: string | null }>,
): Set<string> {
  return new Set<string>([
    ...(profile?.vertical_atoms ?? []),
    ...(profile?.modifier_atoms ?? []),
    ...installed.flatMap((row) => (row.atom_id ? [row.atom_id] : [])),
  ])
}

/**
 * Whether the company's agent gets a knowledge item today: a general item
 * always, any other when the company has chosen it (chosenKnowledge). The
 * catalogue's `active` and the agent picture read this one rule.
 */
export function isActiveKnowledge(tier: string, id: string, chosen: ReadonlySet<string>): boolean {
  return tier === 'horizontal' || chosen.has(id)
}

/**
 * The groups of the knowledge folders. What the agent gets today comes
 * first: the company's industry items, the general rules, the items for its
 * form or situation. Then what exists but is not active for the company.
 * `all` is the one group there is when it is not known which are active.
 */
export type KnowledgeGroupId = 'industry' | 'general' | 'form' | 'also' | 'all'

const ACTIVE_GROUP: Record<'vertical' | 'horizontal' | 'modifier', KnowledgeGroupId> = { vertical: 'industry', horizontal: 'general', modifier: 'form' }
const GROUP_ORDER: readonly KnowledgeGroupId[] = ['industry', 'general', 'form', 'also']

export interface KnowledgeGroups<T> {
  /** The groups in the order they are shown; a group with nothing in it is left out. */
  groups: Array<{ id: KnowledgeGroupId; items: T[] }>
  /** How many items the agent gets today; null when that is not known. */
  active: number | null
}

/**
 * The catalogue's knowledge list in groups, from what each item carries:
 * its tier, and whether it is among the ids the agent gets today (`active`).
 * With `active` unknown nothing is guessed: every item is in one group and
 * none is called active or not.
 */
export function groupKnowledge<T extends { id: string; tier: KnowledgeOption['tier'] }>(options: readonly T[], active: ReadonlySet<string> | null): KnowledgeGroups<T> {
  const list = catalogueKnowledge(options)
  if (!active) return { groups: list.length > 0 ? [{ id: 'all', items: list }] : [], active: null }
  const groupOf = (item: T): KnowledgeGroupId => (active.has(item.id) ? ACTIVE_GROUP[item.tier as keyof typeof ACTIVE_GROUP] : 'also')
  const groups = GROUP_ORDER.map((id) => ({ id, items: list.filter((item) => groupOf(item) === id) })).filter((group) => group.items.length > 0)
  return { groups, active: list.filter((item) => active.has(item.id)).length }
}

/** More tiles than this get a search field; fewer are read at a glance. */
export const SEARCH_FROM_TILES = 30

/**
 * What the line above a knowledge item's text says about the text, by the
 * item's tier. An item the product ships is written for an AI to read, and
 * the line says so. A general item is written in English, every one of them,
 * so its line says that too (`ai_english`). An industry or company-form item
 * is written in Swedish or in English, item by item, and the registry does
 * not say which, so its line names no language (`ai`). What the company or
 * the community wrote gets no line: null.
 */
export type KnowledgeTextNote = 'ai_english' | 'ai'

export function knowledgeTextNote(tier: KnowledgeOption['tier']): KnowledgeTextNote | null {
  if (tier === 'horizontal') return 'ai_english'
  if (tier === 'vertical' || tier === 'modifier') return 'ai'
  return null
}
