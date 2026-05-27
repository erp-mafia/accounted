import { describe, it, expect } from 'vitest'
import { parseInvoiceDateRange } from '../date-range-parser'

describe('parseInvoiceDateRange — ISO patterns', () => {
  it('parses "period: 2026-01-01 till 2027-12-31"', () => {
    expect(parseInvoiceDateRange('period: 2026-01-01 till 2027-12-31')).toEqual({
      startDate: '2026-01-01',
      endDate: '2027-12-31',
    })
  })

  it('parses "perioden 2026-01-01 - 2026-12-31"', () => {
    expect(parseInvoiceDateRange('perioden 2026-01-01 - 2026-12-31')).toEqual({
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    })
  })

  it('parses ISO with en dash', () => {
    expect(parseInvoiceDateRange('2026-01-01–2026-06-30')).toEqual({
      startDate: '2026-01-01',
      endDate: '2026-06-30',
    })
  })

  it('parses "giltig från 2026-01-01 till 2027-12-31"', () => {
    expect(parseInvoiceDateRange('giltig från 2026-01-01 till 2027-12-31')).toEqual({
      startDate: '2026-01-01',
      endDate: '2027-12-31',
    })
  })

  it('handles t.o.m. as the separator', () => {
    expect(parseInvoiceDateRange('Faktura 2026-01-01 t.o.m. 2026-12-31')).toEqual({
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    })
  })
})

describe('parseInvoiceDateRange — Swedish long form', () => {
  it('parses "period: 1 jan 2026 - 31 dec 2026"', () => {
    expect(parseInvoiceDateRange('period: 1 jan 2026 - 31 dec 2026')).toEqual({
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    })
  })

  it('parses month-only form "jan 2026 till dec 2026"', () => {
    expect(parseInvoiceDateRange('Premie för perioden jan 2026 till dec 2026')).toEqual({
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    })
  })

  it('uses last day of month for non-31-day months in Swedish form', () => {
    // feb-feb expands to a Feb 1 → Feb 28 window — the "same month" case
    // still has measurable length so it's accepted, not rejected.
    expect(parseInvoiceDateRange('feb 2026 till feb 2026')).toEqual({
      startDate: '2026-02-01',
      endDate: '2026-02-28',
    })
    expect(parseInvoiceDateRange('jan 2026 till feb 2026')).toEqual({
      startDate: '2026-01-01',
      endDate: '2026-02-28', // 2026 is not a leap year
    })
  })

  it('handles leap year correctly', () => {
    expect(parseInvoiceDateRange('jan 2024 till feb 2024')).toEqual({
      startDate: '2024-01-01',
      endDate: '2024-02-29',
    })
  })

  it('parses full Swedish month names', () => {
    expect(parseInvoiceDateRange('januari 2026 till december 2026')).toEqual({
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    })
  })
})

describe('parseInvoiceDateRange — yyyy-mm form', () => {
  it('parses "2026-01 till 2027-12"', () => {
    expect(parseInvoiceDateRange('Avtal 2026-01 till 2027-12')).toEqual({
      startDate: '2026-01-01',
      endDate: '2027-12-31',
    })
  })

  it('does NOT misparse a full ISO ymd as a yyyy-mm prefix', () => {
    // The leading "2026-01-01" should not be eaten by the yyyy-mm regex —
    // the iso-iso branch should handle this first.
    expect(parseInvoiceDateRange('period 2026-01-01 till 2026-12-31')).toEqual({
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    })
  })
})

describe('parseInvoiceDateRange — rejected inputs', () => {
  it('returns null for a single date with no end', () => {
    expect(parseInvoiceDateRange('Faktura daterad 2026-01-01')).toBeNull()
  })

  it('returns null for a future-only date "från 2026-01-01"', () => {
    expect(parseInvoiceDateRange('Gäller från 2026-01-01')).toBeNull()
  })

  it('returns null for malformed date "2026-13-01"', () => {
    expect(parseInvoiceDateRange('period: 2026-13-01 till 2026-12-31')).toBeNull()
  })

  it('returns null when end <= start', () => {
    expect(parseInvoiceDateRange('2026-12-31 till 2026-01-01')).toBeNull()
  })

  it('returns null for empty / null input', () => {
    expect(parseInvoiceDateRange('')).toBeNull()
    expect(parseInvoiceDateRange(null)).toBeNull()
    expect(parseInvoiceDateRange(undefined)).toBeNull()
  })

  it('returns null for completely irrelevant text', () => {
    expect(parseInvoiceDateRange('Tack för att du handlar hos oss!')).toBeNull()
  })

  it('returns null when only one side is parseable', () => {
    // "Q1 2026" is not in the supported grammar.
    expect(parseInvoiceDateRange('period Q1 2026 till Q2 2026')).toBeNull()
  })
})
