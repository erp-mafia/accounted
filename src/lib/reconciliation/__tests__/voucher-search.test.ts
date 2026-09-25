import { describe, it, expect } from 'vitest'
import { matchesVoucherSearch, type SearchableVoucherLine } from '../voucher-search'

function line(overrides: Partial<SearchableVoucherLine> = {}): SearchableVoucherLine {
  return {
    debit_amount: 25000,
    credit_amount: 0,
    entry_date: '2026-07-30',
    entry_description: 'Rättelse: insättning',
    line_description: null,
    voucher: 'A6',
    ...overrides,
  }
}

describe('matchesVoucherSearch', () => {
  it('matches everything on an empty term', () => {
    expect(matchesVoucherSearch(line(), '   ')).toBe(true)
  })

  it('does not let "25000" hit a 250 000 kr verifikat (no digit substring match)', () => {
    expect(matchesVoucherSearch(line({ debit_amount: 250000, voucher: 'A2' }), '25000')).toBe(false)
    expect(matchesVoucherSearch(line(), '25000')).toBe(true)
  })

  it('accepts Swedish amount formats', () => {
    for (const term of ['25 000', '25 000', '25000,00', '25000.00', '25 000,00', '-25000']) {
      expect(matchesVoucherSearch(line(), term)).toBe(true)
    }
  })

  it('matches a credit line by magnitude, to the öre', () => {
    const credit = line({ debit_amount: 0, credit_amount: 1672.99 })
    expect(matchesVoucherSearch(credit, '-1672,99')).toBe(true)
    expect(matchesVoucherSearch(credit, '1672,99')).toBe(true)
    expect(matchesVoucherSearch(credit, '1672,9')).toBe(false)
    expect(matchesVoucherSearch(credit, '1672')).toBe(false)
  })

  it('keeps voucher number, date and description as text search', () => {
    expect(matchesVoucherSearch(line(), 'a6')).toBe(true)
    expect(matchesVoucherSearch(line(), '2026-07')).toBe(true)
    expect(matchesVoucherSearch(line(), 'rättelse')).toBe(true)
    expect(matchesVoucherSearch(line({ line_description: 'OCR 4455' }), '4455')).toBe(true)
    expect(matchesVoucherSearch(line(), 'A7')).toBe(false)
  })
})
