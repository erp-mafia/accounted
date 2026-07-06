import { describe, it, expect } from 'vitest'
import { formatAmount, formatWholeKr, formatDateTime, formatDate, isSaneDateString } from '@/lib/utils'

// Intl sv-SE groups thousands with a non-breaking / narrow space (U+00A0 or
// U+202F depending on ICU version) and may render negatives with U+2212. Both
// vary across Node builds, so normalize them to plain ASCII before asserting:
// the test cares about format shape, not the exact whitespace codepoint.
const norm = (s: string) => s.replace(/\s/g, ' ').replace(/−/g, '-')

describe('formatAmount', () => {
  it('renders two decimals with sv-SE grouping and no currency symbol', () => {
    expect(norm(formatAmount(1234.5))).toBe('1 234,50')
    expect(norm(formatAmount(0))).toBe('0,00')
    expect(norm(formatAmount(-1234.56))).toBe('-1 234,56')
  })

  it('does not include "kr" or the SEK symbol', () => {
    expect(formatAmount(100)).not.toMatch(/kr|SEK/)
  })
})

describe('formatWholeKr', () => {
  it('rounds to whole krona with grouping, no decimals', () => {
    expect(norm(formatWholeKr(1234.56))).toBe('1 235')
    expect(norm(formatWholeKr(999.4))).toBe('999')
    expect(norm(formatWholeKr(0))).toBe('0')
  })
})

describe('formatDateTime', () => {
  it('renders ISO-ordered date and time', () => {
    expect(formatDateTime('2026-05-11T14:30:00')).toBe('2026-05-11 14:30')
  })

  it('accepts a Date instance', () => {
    expect(formatDateTime(new Date('2026-01-02T09:05:00'))).toBe('2026-01-02 09:05')
  })

  it('stays date-aligned with formatDate on the date portion', () => {
    const iso = '2026-12-31T23:59:00'
    expect(formatDateTime(iso).startsWith(formatDate(iso))).toBe(true)
  })
})

describe('formatDate', () => {
  it('formats a valid ISO date', () => {
    expect(formatDate('2026-05-11')).toBe('2026-05-11')
  })

  it('fails closed on a malformed date instead of throwing', () => {
    // Regression: a 6-digit year ('202403-02-05', the real incident) parses to
    // an Invalid Date; date-fns format() throws on that and used to crash the
    // whole transactions route via the error boundary. It must degrade, not throw.
    expect(() => formatDate('202403-02-05')).not.toThrow()
    expect(formatDate('202403-02-05')).toBe('-')
    expect(formatDate('not-a-date')).toBe('-')
  })
})

describe('isSaneDateString', () => {
  it('accepts real, in-range YYYY-MM-DD dates', () => {
    expect(isSaneDateString('2026-06-04')).toBe(true)
    expect(isSaneDateString('2024-03-02')).toBe(true)
  })

  it('rejects the 6-digit-year corruption from native date inputs', () => {
    expect(isSaneDateString('202403-02-05')).toBe(false)
  })

  it('rejects impossible and out-of-range dates', () => {
    expect(isSaneDateString('2024-13-40')).toBe(false) // month 13 / day 40
    expect(isSaneDateString('1899-12-31')).toBe(false) // below floor
    expect(isSaneDateString('2101-01-01')).toBe(false) // above ceiling
  })

  it('rejects empty and non-date strings', () => {
    expect(isSaneDateString('')).toBe(false)
    expect(isSaneDateString('not-a-date')).toBe(false)
  })
})
