/** Shortest term the bank-row search sends to the database. */
export const TRANSACTION_SEARCH_MIN_CHARS = 2

/** The bank-row text columns a search can match. */
export type TransactionSearchColumn = 'description' | 'merchant_name' | 'reference'

/**
 * The PostgREST `.or()` filter that matches a free-text term against a bank
 * row's description or merchant name (or the text columns a caller names),
 * or null for a term too short to search.
 *
 * The term is interpolated into the filter DSL, so its structural characters
 * are stripped first: commas separate OR conditions and parentheses group
 * them, so leaving them in would let a term inject a clause
 * ("Acme,company_id.neq..."); `%`, `*` and `\` are LIKE wildcards and escapes.
 * `.` is safe: it stays inside the ilike value.
 */
export function transactionTextSearchFilter(
  term: string,
  columns: readonly TransactionSearchColumn[] = ['description', 'merchant_name'],
): string | null {
  const safe = term.replace(/[%*,()\\]/g, ' ').trim()
  if (safe.length < TRANSACTION_SEARCH_MIN_CHARS) return null
  return columns.map((column) => `${column}.ilike.%${safe}%`).join(',')
}
