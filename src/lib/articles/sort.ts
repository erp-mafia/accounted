/**
 * Canonical ordering for article lists and pickers: by article number with
 * numeric-aware comparison ('2' before '10'), articles without a number last,
 * name as tie-breaker. Users number their articles to control this order
 * (issue #1053), so a plain string sort ('10' < '2') or name sort breaks it.
 */

interface SortableArticle {
  article_number?: string | null
  name: string
}

const numberCollator = new Intl.Collator('sv', { numeric: true, sensitivity: 'base' })

export function compareArticles(a: SortableArticle, b: SortableArticle): number {
  const aNum = a.article_number?.trim()
  const bNum = b.article_number?.trim()
  if (aNum && bNum) {
    const byNumber = numberCollator.compare(aNum, bNum)
    if (byNumber !== 0) return byNumber
  } else if (aNum) {
    return -1
  } else if (bNum) {
    return 1
  }
  return numberCollator.compare(a.name, b.name)
}

export function sortArticles<T extends SortableArticle>(articles: T[]): T[] {
  return [...articles].sort(compareArticles)
}
