import { describe, it, expect } from 'vitest'
import {
  formatChipDate,
  invoiceDateLock,
  resolveDetailsChips,
  resolveDetailsExpansion,
  termDays,
  type DetailsChipsInput,
  type DetailsExpansionInput,
} from '@/lib/invoices/editor/details'

function expansion(overrides: Partial<DetailsExpansionInput> = {}): DetailsExpansionInput {
  return {
    documentType: 'invoice',
    isSelfBilled: false,
    currency: 'SEK',
    language: 'sv',
    customerType: 'swedish_business',
    invoiceDate: '2026-10-02',
    deliveryDate: '',
    validUntil: '',
    dateLock: null,
    ...overrides,
  }
}

describe('resolveDetailsExpansion', () => {
  it('stays folded for the everyday Swedish SEK invoice', () => {
    expect(resolveDetailsExpansion(expansion())).toEqual([])
    expect(resolveDetailsExpansion(expansion({ customerType: 'individual' }))).toEqual([])
  })

  it('opens for a foreign currency, an English customer and a foreign business', () => {
    expect(resolveDetailsExpansion(expansion({ currency: 'EUR' }))).toEqual(['currency'])
    expect(resolveDetailsExpansion(expansion({ language: 'en' }))).toEqual(['language'])
    expect(resolveDetailsExpansion(expansion({ customerType: 'eu_business' }))).toEqual(['foreign_customer'])
    expect(resolveDetailsExpansion(expansion({ customerType: 'non_eu_business' }))).toEqual(['foreign_customer'])
    expect(
      resolveDetailsExpansion(expansion({ currency: 'EUR', language: 'en', customerType: 'eu_business' })),
    ).toEqual(['currency', 'language', 'foreign_customer'])
  })

  it('opens for a delivery date only when it differs from the invoice date', () => {
    expect(resolveDetailsExpansion(expansion({ deliveryDate: '2026-09-28' }))).toEqual(['delivery_date'])
    expect(resolveDetailsExpansion(expansion({ deliveryDate: '2026-10-02' }))).toEqual([])
    // A quote has no delivery date.
    expect(resolveDetailsExpansion(expansion({ documentType: 'quote', deliveryDate: '2026-09-28' }))).toEqual([])
  })

  it('opens for a locked invoice date', () => {
    expect(resolveDetailsExpansion(expansion({ dateLock: 'company_lock' }))).toEqual(['date_locked'])
  })

  it('opens a quote only when it expires before its own date', () => {
    expect(
      resolveDetailsExpansion(expansion({ documentType: 'quote', validUntil: '2026-11-01' })),
    ).toEqual([])
    expect(
      resolveDetailsExpansion(expansion({ documentType: 'quote', validUntil: '2026-09-01' })),
    ).toEqual(['quote_validity'])
  })

  it('judges a received självfaktura on currency and the lock only', () => {
    expect(
      resolveDetailsExpansion(
        expansion({ isSelfBilled: true, language: 'en', customerType: 'eu_business', deliveryDate: '2026-09-01' }),
      ),
    ).toEqual([])
    expect(resolveDetailsExpansion(expansion({ isSelfBilled: true, currency: 'USD' }))).toEqual(['currency'])
  })
})

describe('invoiceDateLock', () => {
  const periods = [
    { period_start: '2025-01-01', period_end: '2025-12-31', is_closed: true, locked_at: '2026-02-01T00:00:00Z' },
    { period_start: '2026-01-01', period_end: '2026-12-31', is_closed: false, locked_at: null },
  ]

  it('applies the company lock date inclusively', () => {
    expect(invoiceDateLock({ date: '2026-06-30', lockedThrough: '2026-06-30', periods })).toBe('company_lock')
    expect(invoiceDateLock({ date: '2026-07-01', lockedThrough: '2026-06-30', periods })).toBeNull()
  })

  it('refuses a closed or locked fiscal period', () => {
    expect(invoiceDateLock({ date: '2025-11-30', lockedThrough: null, periods })).toBe('closed_period')
    expect(
      invoiceDateLock({
        date: '2026-03-01',
        lockedThrough: null,
        periods: [{ ...periods[1], locked_at: '2026-09-01T00:00:00Z' }],
      }),
    ).toBe('locked_period')
  })

  it('says nothing about a half-typed date', () => {
    expect(invoiceDateLock({ date: '2025-1', lockedThrough: '2026-06-30', periods })).toBeNull()
    expect(invoiceDateLock({ date: '', lockedThrough: '2026-06-30', periods })).toBeNull()
  })
})

function chips(overrides: Partial<DetailsChipsInput> = {}): DetailsChipsInput {
  return {
    documentType: 'invoice',
    isSelfBilled: false,
    invoiceDate: '2026-10-02',
    dueDate: '2026-11-01',
    validUntil: '2026-11-01',
    currency: 'SEK',
    language: 'sv',
    deliveryDate: '',
    dimensionsEnabled: false,
    dims: null,
    ...overrides,
  }
}

describe('resolveDetailsChips', () => {
  it('reads Fakturadatum, Förfaller, valuta, språk and + Leveransdatum', () => {
    expect(resolveDetailsChips(chips())).toEqual([
      { kind: 'invoice_date', date: '2026-10-02' },
      { kind: 'due', date: '2026-11-01', days: 30 },
      { kind: 'currency', currency: 'SEK' },
      { kind: 'language', language: 'sv' },
      { kind: 'delivery', date: null },
    ])
  })

  it('shows Giltig till instead of a due date on a quote, and no delivery date', () => {
    expect(resolveDetailsChips(chips({ documentType: 'quote' }))).toEqual([
      { kind: 'invoice_date', date: '2026-10-02' },
      { kind: 'valid_until', date: '2026-11-01', days: 30 },
      { kind: 'currency', currency: 'SEK' },
      { kind: 'language', language: 'sv' },
    ])
  })

  it('adds the dimensions chip where dimensions are on', () => {
    expect(resolveDetailsChips(chips({ dimensionsEnabled: true, dims: 'KS01' })).at(-1)).toEqual({
      kind: 'dimensions',
      dims: 'KS01',
    })
    expect(resolveDetailsChips(chips({ dimensionsEnabled: true })).at(-1)).toEqual({ kind: 'dimensions', dims: null })
  })

  it('keeps a självfaktura to the due date and the currency', () => {
    expect(resolveDetailsChips(chips({ isSelfBilled: true }))).toEqual([
      { kind: 'due', date: '2026-11-01', days: 30 },
      { kind: 'currency', currency: 'SEK' },
    ])
  })
})

describe('termDays', () => {
  it('counts calendar days and gives up on a missing date', () => {
    expect(termDays('2026-10-02', '2026-11-01')).toBe(30)
    expect(termDays('', '2026-11-01')).toBeNull()
  })
})

describe('formatChipDate', () => {
  it('writes a short day and month, the year only when it is not this year', () => {
    expect(formatChipDate('2026-10-02', 'sv', '2026-10-02')).toBe('2 okt')
    expect(formatChipDate('2025-10-02', 'sv', '2026-10-02')).toBe('2 okt 2025')
    expect(formatChipDate('2026-10-02', 'en', '2026-10-02')).toBe('2 Oct')
  })

  it('leaves a value that is not a date alone', () => {
    expect(formatChipDate('2026-1', 'sv', '2026-10-02')).toBe('2026-1')
  })
})
