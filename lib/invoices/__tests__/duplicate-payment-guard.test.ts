import { describe, it, expect } from 'vitest'
import { escapeLikePattern, normalizeOcrReference } from '../duplicate-payment-guard'

describe('escapeLikePattern', () => {
  // These cases lock in that a user-supplied needle reaches an ILIKE pattern with
  // its LIKE metacharacters neutralised: each of `%`, `_`, `\` must match only
  // itself and never expand as a wildcard (compliance A.8.28 / ASVS V1.2.5).
  it('escapes a literal percent so it matches only itself', () => {
    expect(escapeLikePattern('50% rabatt')).toBe('50\\% rabatt')
  })

  it('escapes a literal underscore so it is not a single-char wildcard', () => {
    expect(escapeLikePattern('konto_1930')).toBe('konto\\_1930')
  })

  it('escapes a literal backslash so it does not consume the next char', () => {
    expect(escapeLikePattern('a\\b')).toBe('a\\\\b')
  })

  it('escapes backslash, percent and underscore together without double-escaping', () => {
    // Backslash is escaped FIRST, so the escapes added for % and _ are not
    // themselves re-escaped. Each special char maps to exactly "\\" + itself.
    expect(escapeLikePattern('a\\b%c_d')).toBe('a\\\\b\\%c\\_d')
  })

  it('leaves ordinary text untouched', () => {
    expect(escapeLikePattern('Faktura 2026-0042')).toBe('Faktura 2026-0042')
  })

  it('caps the needle at 200 characters to bound DB work on oversized input', () => {
    const escaped = escapeLikePattern('a'.repeat(250))
    expect(escaped).toBe('a'.repeat(200))
    expect(escaped.length).toBe(200)
  })

  it('truncates BEFORE escaping, so the source length is the bound', () => {
    // 250 percent signs → truncated to 200 source chars, each escaped to "\%".
    expect(escapeLikePattern('%'.repeat(250))).toBe('\\%'.repeat(200))
  })
})

describe('normalizeOcrReference', () => {
  it('keeps only digits regardless of separators', () => {
    expect(normalizeOcrReference('2026-0042')).toBe('20260042')
    expect(normalizeOcrReference('2026 / 0042')).toBe('20260042')
  })

  it('returns an empty string for nullish or empty input', () => {
    expect(normalizeOcrReference(null)).toBe('')
    expect(normalizeOcrReference(undefined)).toBe('')
    expect(normalizeOcrReference('')).toBe('')
  })
})
