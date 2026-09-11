/**
 * Shared column-detection helpers for register imports
 * (customers, suppliers, articles, employees).
 */

import { roundOre } from '@/lib/money'

export function normalize(header: string): string {
  return header.toLowerCase().trim().replace(/[_\-./]/g, ' ')
}

export function matchesKeywords(header: string, keywords: string[]): boolean {
  const normalized = normalize(header)
  return keywords.some((kw) => normalized === kw || normalized.includes(kw))
}

/**
 * Find the first column index whose header matches one of `keywords`,
 * skipping any indices already taken by other columns.
 */
export function findColumn(
  headers: string[],
  keywords: string[],
  taken: Set<number>,
): number | null {
  for (let i = 0; i < headers.length; i++) {
    if (taken.has(i)) continue
    if (matchesKeywords(headers[i], keywords)) {
      taken.add(i)
      return i
    }
  }
  return null
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
