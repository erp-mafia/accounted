import { isOwnItem, ownItemHref, type SkillSummary } from './data'
import type { ItemKind } from './hues'

/** One of the company's own items as the agent picture's Kunskap panel lists it. */
export interface OwnItemRow {
  key: string
  /** A flow, knowledge or an analysis: an item saved without a kind is a flow, as in the catalogue. */
  kind: ItemKind
  title: string
  desc: string
  /** The item's own page: where the catalogue's Egna opens it. */
  href: string
  /** Saved by an AI and not yet added by a person. */
  draft: boolean
  /** The company's own item, or one its firm keeps for its companies: the panel marks the firm's with a word. */
  scope: 'company' | 'team'
}

/**
 * The company's own items of every kind, as the catalogue page lists them
 * under Egna (isOwnItem): its own flows, knowledge and analyses and its
 * firm's, each under the name and the one line it was saved with, opening
 * the page the catalogue opens it on (ownItemHref).
 *
 * What waits for a person comes first (a draft an AI saved), then by name.
 *
 * Pure, so it is tested without React.
 */
export function ownItemRows(catalog: readonly SkillSummary[], hrefBase: string): OwnItemRow[] {
  return catalog
    .filter(isOwnItem)
    .map((skill): OwnItemRow => {
      const kind: ItemKind = skill.itemKind ?? 'workflow'
      return {
        key: skill.slug,
        kind,
        title: skill.name,
        desc: skill.summary,
        href: ownItemHref(hrefBase, skill.slug, kind),
        draft: skill.draft === true,
        scope: skill.installations[0].scope,
      }
    })
    .sort((a, b) => Number(b.draft) - Number(a.draft) || a.title.localeCompare(b.title, 'sv'))
}
