/**
 * Shared column-detection helpers for register imports
 * (customers, suppliers, articles, employees).
 *
 * Matching is scored, not first-substring-wins: every untaken header is graded
 * against the field's keywords (exact header > whole word inside it > bare
 * substring) and the best-graded header wins the field. First-substring-wins is
 * what let "Supplier number" become the name column and "Corporate identity
 * number" become address line 2 in Visma and Spiris exports (#2548).
 */

import { roundOre } from '@/lib/money'

export function normalize(header: string): string {
  return header
    .toLowerCase()
    .trim()
    .replace(/[_\-./]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** How well a header matched a keyword list, best tier first. */
export type MatchTier = 'exact' | 'word' | 'substring'

const TIER_RANK: Record<MatchTier, number> = { exact: 3, word: 2, substring: 1 }

/**
 * Keywords shorter than this only match as a whole word, never as a bare
 * substring: "vat" hits "Privat", "co" hits "Corporate" and "Country", "org"
 * hits "Norge". Longer keywords keep the substring tier (it is still the
 * weakest, so a stronger match on another header wins).
 */
const MIN_SUBSTRING_KEYWORD_LENGTH = 4

/** True when `needle` occurs in `haystack` bounded by spaces or string ends. */
function containsWholeWord(haystack: string, needle: string): boolean {
  if (needle === '') return false
  let from = 0
  for (;;) {
    const idx = haystack.indexOf(needle, from)
    if (idx === -1) return false
    const endsAt = idx + needle.length
    const beforeOk = idx === 0 || haystack[idx - 1] === ' '
    const afterOk = endsAt === haystack.length || haystack[endsAt] === ' '
    if (beforeOk && afterOk) return true
    from = idx + 1
  }
}

/**
 * Grade one header against a keyword list. Returns the best tier reached, or
 * null when the header matches nothing.
 */
export function matchTier(header: string, keywords: string[]): MatchTier | null {
  const normalized = normalize(header)
  if (normalized === '') return null

  let best: MatchTier | null = null
  for (const raw of keywords) {
    const kw = normalize(raw)
    if (kw === '') continue
    if (normalized === kw) return 'exact'
    if (containsWholeWord(normalized, kw)) {
      best = 'word'
      continue
    }
    if (
      best === null
      && kw.length >= MIN_SUBSTRING_KEYWORD_LENGTH
      && normalized.includes(kw)
    ) {
      best = 'substring'
    }
  }
  return best
}

export function matchesKeywords(header: string, keywords: string[]): boolean {
  return matchTier(header, keywords) !== null
}

/**
 * Headers that identify a record by number, never by name. Passed as `reject`
 * for name columns so "Supplier number" / "Leverantörsnummer" cannot win the
 * name field just because they contain "supplier" / "leverantör".
 */
export const EXTERNAL_NUMBER_KEYWORDS = [
  'number', 'nummer', 'nr', 'no', 'id',
  'supplier number', 'supplier no', 'supplier id',
  'customer number', 'customer no', 'customer id',
  'vendor number', 'vendor no', 'vendor id',
  'article number', 'item number',
  'leverantörsnummer', 'leverantorsnummer', 'leverantörsnr', 'leverantorsnr',
  'kundnummer', 'kundnr', 'artikelnummer', 'artikelnr',
  'företagsnummer', 'foretagsnummer',
]

export interface FindColumnOptions {
  /**
   * Headers matching one of these exactly or as a whole word are disqualified
   * for this field, however well they match its own keywords.
   */
  reject?: string[]
}

export interface ColumnMatch {
  index: number
  tier: MatchTier
}

/**
 * Find the best-matching untaken column for `keywords` and claim it.
 * Ties (equal tier) go to the leftmost column.
 */
export function findColumnMatch(
  headers: string[],
  keywords: string[],
  taken: Set<number>,
  options?: FindColumnOptions,
): ColumnMatch | null {
  let best: ColumnMatch | null = null

  for (let i = 0; i < headers.length; i++) {
    if (taken.has(i)) continue
    const tier = matchTier(headers[i], keywords)
    if (tier === null) continue
    if (options?.reject) {
      const rejected = matchTier(headers[i], options.reject)
      if (rejected === 'exact' || rejected === 'word') continue
    }
    if (best === null || TIER_RANK[tier] > TIER_RANK[best.tier]) {
      best = { index: i, tier }
      if (tier === 'exact') break
    }
  }

  if (best !== null) taken.add(best.index)
  return best
}

/**
 * Find the best column index whose header matches one of `keywords`,
 * skipping any indices already taken by other columns.
 */
export function findColumn(
  headers: string[],
  keywords: string[],
  taken: Set<number>,
  options?: FindColumnOptions,
): number | null {
  return findColumnMatch(headers, keywords, taken, options)?.index ?? null
}

/** Trim a string-or-blank cell, returning null when empty. */
export function cellOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const str = String(value).trim()
  return str === '' ? null : str
}

/** Parse an integer payment term ("30 dagar" → 30) with a default fallback. */
export function parsePaymentTerms(value: unknown, fallback: number): number {
  const str = cellOrNull(value)
  if (!str) return fallback
  const match = str.match(/-?\d+/)
  if (!match) return fallback
  const n = parseInt(match[0], 10)
  if (isNaN(n) || n < 0 || n > 365) return fallback
  return n
}

/**
 * Normalize an org/personal number to its dedup key (digits only).
 * Returns null for empty input or strings that contain no digits.
 */
export function normalizeOrgNumber(value: string | null): string | null {
  if (!value) return null
  return value.replace(/\D/g, '') || null
}

/**
 * Normalize an email to its dedup key (trimmed + lowercased).
 * Returns null for empty/whitespace-only input.
 */
export function normalizeEmail(value: string | null): string | null {
  if (!value) return null
  return value.trim().toLowerCase() || null
}

/**
 * Lowercased dedup key for matching a row by name (articles, and any other
 * importer that dedupes on a free-text name). Same rule as normalizeEmail.
 */
export function normalizeNameKey(value: string | null): string | null {
  if (!value) return null
  return value.trim().toLowerCase() || null
}

/**
 * Parse a decimal cell ("45 000", "45000,50", 45000.5) into a number with
 * öre precision. Returns null for an empty or non-numeric cell so the caller
 * can tell "not given" from 0. Percent signs are stripped so "80 %" reads 80.
 */
export function parseDecimal(value: unknown): number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') {
    return Number.isFinite(value) ? roundOre(value) : null
  }
  const str = String(value).trim()
  if (str === '' || str === '-') return null
  const cleaned = str
    .replace(/%/g, '')
    .replace(/(kr|sek)$/i, '')
    .replace(/\s/g, '')
    .replace(/\.(?=\d{3}(\D|$))/g, '')
    .replace(',', '.')
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null
  const num = parseFloat(cleaned)
  return Number.isFinite(num) ? roundOre(num) : null
}
