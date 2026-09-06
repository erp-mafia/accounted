import { describe, it, expect } from 'vitest'
import {
  COUNTERPARTY_NEEDLE_SHAPE,
  counterpartyNeedle,
  counterpartySearchTerms,
  escapeLikePattern,
  normalizeOcrReference,
} from '../duplicate-payment-guard'

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

describe('counterpartyNeedle', () => {
  // Issue #2299: the bank feed wrote "HI3G" (merchant_name empty) for the row
  // that paid Hi3G Access AB, and a full-name needle can never hit that. The
  // needle is the first distinctive word, as a bank abbreviates.
  it('takes the first distinctive token: Hi3G Access AB -> hi3g', () => {
    expect(counterpartyNeedle('Hi3G Access AB')).toBe('hi3g')
  })

  it('skips a leading legal form: AB Volvo -> volvo, Aktiebolaget Elektro -> elektro', () => {
    expect(counterpartyNeedle('AB Volvo')).toBe('volvo')
    expect(counterpartyNeedle('Aktiebolaget Elektro')).toBe('elektro')
    expect(counterpartyNeedle('Handelsbolaget Bröderna Ek')).toBe('bröderna')
  })

  it('keeps Swedish letters so "Leverantör AB" probes on leverantör, not leverantr', () => {
    expect(counterpartyNeedle('Leverantör AB')).toBe('leverantör')
    expect(counterpartyNeedle('Åkeriet i Örebro AB')).toBe('åkeriet')
  })

  it('keeps two-letter initialisms a bank writes verbatim: SJ AB -> sj, 3M Svenska AB -> 3m', () => {
    expect(counterpartyNeedle('SJ AB')).toBe('sj')
    expect(counterpartyNeedle('3M Svenska AB')).toBe('3m')
    expect(counterpartyNeedle('DB Schenker')).toBe('db')
  })

  it('strips punctuation inside a token: "Acme, Inc." -> acme, "H&M Hennes & Mauritz" -> hm', () => {
    expect(counterpartyNeedle('Acme, Inc.')).toBe('acme')
    expect(counterpartyNeedle('H&M Hennes & Mauritz AB')).toBe('hm')
  })

  it('returns null when nothing usable remains: legal form only, one-char tokens, empty', () => {
    expect(counterpartyNeedle('AB')).toBeNull()
    expect(counterpartyNeedle('3 AB')).toBeNull()
    expect(counterpartyNeedle('')).toBeNull()
    expect(counterpartyNeedle(null)).toBeNull()
    expect(counterpartyNeedle(undefined)).toBeNull()
    expect(counterpartyNeedle('   ')).toBeNull()
  })

  it('never yields PostgREST filter-DSL or LIKE metacharacters, whatever the name contains', () => {
    // The needle is interpolated into `.or('merchant_name.ilike.%x%,description.ilike.%x%')`,
    // where `,` `.` `(` `)` would inject a clause and `%` `_` `\` would widen the match.
    const hostile = ['Acme,fake.eq.true', '50% Off_AB', 'a\\b(c)', 'x.ilike.%', 'Kalle & Co']
    for (const name of hostile) {
      const needle = counterpartyNeedle(name)
      expect(needle).not.toBeNull()
      expect(needle).toMatch(COUNTERPARTY_NEEDLE_SHAPE)
      expect(needle).not.toMatch(/[,.()%_\\]/)
    }
    expect(counterpartyNeedle('Acme,fake.eq.true')).toBe('acmefakeeqtrue')
  })

  it('caps the needle so an oversized token still yields a bounded prefix probe', () => {
    expect(counterpartyNeedle('x'.repeat(300))).toBe('x'.repeat(40))
  })
})

describe('counterpartySearchTerms', () => {
  it('normalises every token of three or more characters and drops legal forms', () => {
    expect(counterpartySearchTerms('Hi3G Access AB')).toEqual(['hi3g', 'access'])
    expect(counterpartySearchTerms('Acme, Inc.')).toEqual(['acme'])
    expect(counterpartySearchTerms('SJ AB')).toEqual([])
    expect(counterpartySearchTerms(null)).toEqual([])
  })
})
