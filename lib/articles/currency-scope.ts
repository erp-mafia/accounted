/**
 * Currency scoping for the article register (#1189).
 *
 * Article prices became first-class in non-SEK currencies (#1166), so a mixed
 * register needs a way to look at one currency at a time. The scope is offered
 * as a ContextPicker chip and lives in the URL, which means it arrives as
 * untrusted text: everything here treats an unknown or stale code as "no
 * scope" rather than as a filter that hides every row.
 */

/** Sentinel for "no currency scope". Kept out of the URL when it is the value. */
export const ALL_CURRENCIES = 'all'

/**
 * The register's own default. Rows written before multi-currency support, and
 * any row with a blank currency, are SEK: pricing in Sweden without saying so
 * means kronor.
 */
export const DEFAULT_CURRENCY = 'SEK'

interface CurrencyBearingArticle {
  currency?: string | null
}

/** Normalized currency code of one article. */
export function articleCurrency(article: CurrencyBearingArticle): string {
  return (article.currency || DEFAULT_CURRENCY).toUpperCase()
}

/**
 * The currencies actually present in the register, SEK first and the rest
 * alphabetically. Only these may be offered: a picker listing currencies
 * nobody priced anything in would filter to an empty table.
 */
export function listArticleCurrencies(articles: CurrencyBearingArticle[]): string[] {
  const present = new Set(articles.map(articleCurrency))
  return [...present].sort((a, b) => {
    if (a === DEFAULT_CURRENCY) return -1
    if (b === DEFAULT_CURRENCY) return 1
    return a.localeCompare(b)
  })
}

/**
 * Resolve the scope to apply from the URL parameter. A code that is not in the
 * register (last EUR article deleted, hand-edited or shared link) falls back to
 * ALL_CURRENCIES: showing everything is recoverable, showing nothing reads as
 * data loss.
 */
export function resolveCurrencyScope(
  param: string | null | undefined,
  availableCurrencies: string[],
): string {
  if (!param) return ALL_CURRENCIES
  const normalized = param.toUpperCase()
  return availableCurrencies.includes(normalized) ? normalized : ALL_CURRENCIES
}

/** True when the article belongs in the given scope. */
export function matchesCurrencyScope(
  article: CurrencyBearingArticle,
  scope: string,
): boolean {
  return scope === ALL_CURRENCIES || articleCurrency(article) === scope
}
