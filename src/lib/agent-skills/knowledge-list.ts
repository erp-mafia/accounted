import type { KnowledgeOption } from './knowledge-choices'

/**
 * The catalogue's knowledge list: the knowledge items the product ships.
 * What the community shared and what the company wrote itself are listed in
 * their own places, so they are left out here.
 *
 * One definition for the Kunskap kind of the catalogue, the agent picture's
 * Kunskap list and the number on the picture's card, so the three agree.
 *
 * Pure and browser-safe.
 */
export function catalogueKnowledge(options: readonly KnowledgeOption[]): KnowledgeOption[] {
  return options.filter((option) => option.tier !== 'community' && option.tier !== 'own')
}

/** The list with the company's own industry item first; the rest keep their order. */
export function industryFirst<T extends { key: string }>(items: readonly T[], industry: string | null): T[] {
  if (!industry) return [...items]
  return [...items.filter((item) => item.key === industry), ...items.filter((item) => item.key !== industry)]
}

/** A list this long gets a search field; a shorter one is read at a glance. */
export const SEARCH_FROM_ROWS = 20
