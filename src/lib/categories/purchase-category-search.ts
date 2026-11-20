/**
 * Search over the purchase categories for the picker ("Vad köptes?"): a
 * person types part of a name and the list narrows to what matches. Pure:
 * the names come in already translated (the reader's locale), so this module
 * holds no messages.
 *
 * Matching folds case, diacritics and punctuation ("tag" finds "Tåg",
 * "it support" finds "IT-support"), and every typed word has to match
 * somewhere: the category's name, its group's name, or the start of a word in
 * its line keywords (purchase-category-keywords.ts). The keywords are Swedish
 * and English, so either language finds a category in both locales ("chair"
 * finds Kontorsmöbler, "stol" finds Office furniture).
 *
 * Ranking, best first: a word of the name starting with what was typed, the
 * name containing it, the group's name containing it, a keyword starting
 * with it. Several typed words add up; a tie keeps display order.
 */
import {
  PURCHASE_CATEGORIES,
  PURCHASE_CATEGORY_CODES,
  type PurchaseCategoryCode,
  type PurchaseCategoryGroup,
} from './purchase-categories'
import { PURCHASE_CATEGORY_KEYWORDS } from './purchase-category-keywords'

/** Lower case, diacritics and punctuation dropped, single spaces: what search compares. */
export function foldSearchText(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/** One category as search reads it, folded once so a keystroke is substring checks only. */
export interface PurchaseCategorySearchEntry {
  code: PurchaseCategoryCode
  /** The name, folded, with a leading space so a word start reads as ' ' + the word. */
  name: string
  /** The group's name, folded. */
  groupName: string
  /** Every keyword, folded, each word with a leading space. */
  keywords: string
}

/** The translated names the index is built from: the reader's locale. */
export interface PurchaseCategorySearchNames {
  category: (code: PurchaseCategoryCode) => string
  group: (group: PurchaseCategoryGroup) => string
}

const KEYWORDS: ReadonlyMap<PurchaseCategoryCode, string> = new Map(
  PURCHASE_CATEGORY_CODES.map((code) => {
    const words = PURCHASE_CATEGORY_KEYWORDS[code]
    const all = [...(words?.strong ?? []), ...(words?.weak ?? [])]
    // '=' only tells the line matcher to match a whole word; search ignores it.
    return [code, all.map((w) => ` ${foldSearchText(w.replace(/^=/, ''))}`).join('')]
  }),
)

/** The index, in display order. Build it once per locale. */
export function buildPurchaseCategorySearchIndex(names: PurchaseCategorySearchNames): PurchaseCategorySearchEntry[] {
  return PURCHASE_CATEGORIES.map((category) => ({
    code: category.code,
    name: ` ${foldSearchText(names.category(category.code))}`,
    groupName: foldSearchText(names.group(category.group)),
    keywords: KEYWORDS.get(category.code) ?? '',
  }))
}

/** How well one typed word matches an entry: 0 is best, null is no match. */
function tierOf(entry: PurchaseCategorySearchEntry, word: string): number | null {
  if (entry.name.includes(` ${word}`)) return 0
  if (entry.name.includes(word)) return 1
  if (entry.groupName.includes(word)) return 2
  if (entry.keywords.includes(` ${word}`)) return 3
  return null
}

/**
 * The codes matching the query, best first. An empty query matches every
 * category, in display order.
 */
export function searchPurchaseCategories(
  index: readonly PurchaseCategorySearchEntry[],
  query: string,
): PurchaseCategoryCode[] {
  const words = foldSearchText(query).split(' ').filter(Boolean)
  if (words.length === 0) return index.map((entry) => entry.code)

  const hits: Array<{ code: PurchaseCategoryCode; score: number; order: number }> = []
  index.forEach((entry, order) => {
    let score = 0
    for (const word of words) {
      const tier = tierOf(entry, word)
      if (tier === null) return
      score += tier
    }
    hits.push({ code: entry.code, score, order })
  })
  return hits.sort((a, b) => a.score - b.score || a.order - b.order).map((hit) => hit.code)
}
