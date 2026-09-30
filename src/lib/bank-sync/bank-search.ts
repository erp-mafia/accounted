/**
 * Bank search aliases: the name people search for when their account is sold
 * under a brand that is not the bank holding it.
 *
 * Enable Banking lists institutions by the name of the bank that holds the
 * account (the ASPSP), and the consent runs at that bank. A brand that rides
 * on another bank's licence is therefore invisible to a name-only search even
 * though it connects fine: Bokio Företagskonto is held at Svea Bank, and
 * someone moving from Bokio types "Bokio", not "Svea".
 *
 * Pure and core-safe on purpose: the settings bank picker (enable-banking
 * extension), the onboarding bank step and the ?bank= deep-link resolver all
 * read this one table, so an alias added here reaches every bank search.
 */

export interface BankSearchAlias {
  /** The ASPSP name as Enable Banking lists it (compared case-insensitively). */
  bank: string
  /** The brand people know, named in the hint under the results. */
  product: string
  /** Search terms, already in normalized form (lowercase, single spaces). */
  terms: readonly string[]
}

export const BANK_SEARCH_ALIASES: readonly BankSearchAlias[] = [
  // bokio.se/priser: "Bokio Företagskonto tillhandahålls av Svea Bank".
  { bank: 'Svea Bank', product: 'Bokio Företagskonto', terms: ['bokio', 'bokio företagskonto'] },
]

/** One form for both sides of every comparison: NFC, trimmed, single spaces, lowercase. */
function normalize(value: string): string {
  return value.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase()
}

/**
 * The alias through which `query` finds `bank` when the bank's own name does
 * not, or null.
 *
 * Search-as-you-type: a query that is the start of a term ("bok") or starts
 * with one ("bokio konto") finds the bank, so the row appears while the word
 * is still being typed. A query that only occurs inside a term ("konto") does
 * not: every bank offers a företagskonto, and "konto" listing Svea Bank with a
 * Bokio note would be noise.
 */
export function bankSearchAlias(bank: { name: string }, query: string): BankSearchAlias | null {
  const q = normalize(query)
  if (!q) return null
  const name = normalize(bank.name)
  if (name.includes(q)) return null
  for (const alias of BANK_SEARCH_ALIASES) {
    if (normalize(alias.bank) !== name) continue
    if (alias.terms.some((term) => term.startsWith(q) || q.startsWith(term))) return alias
  }
  return null
}

/** Whether `query` finds `bank`, by its name or through an alias. An empty query finds every bank. */
export function bankMatchesQuery(bank: { name: string }, query: string): boolean {
  const q = normalize(query)
  if (!q) return true
  return normalize(bank.name).includes(q) || bankSearchAlias(bank, q) !== null
}

/**
 * The alias behind the first listed bank that `query` finds only through an
 * alias: what the muted line under the results explains ("Bokio Företagskonto
 * ligger hos Svea Bank."), so a result named after another bank does not look
 * like a wrong match. Null when every result matched by name.
 */
export function searchAliasHint(banks: readonly { name: string }[], query: string): BankSearchAlias | null {
  for (const bank of banks) {
    const alias = bankSearchAlias(bank, query)
    if (alias) return alias
  }
  return null
}

/**
 * The ASPSP name that a complete alias term stands for ("bokio", "Bokio
 * Företagskonto"), or null. Stricter than the search on purpose: the ?bank=
 * deep link starts a consent without a click, so a partial word like "bo"
 * must fall back to the prefilled picker rather than open a bank's login.
 * A term claimed by two aliases names no bank.
 */
export function bankNameForAlias(query: string): string | null {
  const q = normalize(query)
  if (!q) return null
  const hits = BANK_SEARCH_ALIASES.filter((alias) => alias.terms.includes(q))
  return hits.length === 1 ? hits[0].bank : null
}
