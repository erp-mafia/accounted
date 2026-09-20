import { describe, it, expect } from 'vitest'
import {
  indexVatFilings,
  parseVatFilingReference,
  vatFilingDateProblem,
  vatFilingDeadlineType,
  vatFilingKey,
  vatFilingPeriodEnd,
  vatFilingPeriodFromTaxPeriod,
  vatFilingTaxPeriod,
  withVatFilingReference,
  type VatFilingRecord,
} from '../filing-record'

function record(overrides: Partial<VatFilingRecord>): VatFilingRecord {
  return {
    deadline_id: 'd-1',
    period_type: 'quarterly',
    year: 2026,
    period: 2,
    tax_period: '2026-Q2',
    filed_on: '2026-08-10',
    source: 'manual',
    reference: null,
    ...overrides,
  }
}

describe('tax_period key mapping', () => {
  it('formats the generator key for both cadences', () => {
    expect(vatFilingTaxPeriod('monthly', 2026, 3)).toBe('2026-03')
    expect(vatFilingTaxPeriod('quarterly', 2026, 2)).toBe('2026-Q2')
    expect(vatFilingDeadlineType('monthly')).toBe('moms_monthly')
    expect(vatFilingDeadlineType('quarterly')).toBe('moms_quarterly')
  })

  it('parses calendar keys and rejects everything else', () => {
    expect(vatFilingPeriodFromTaxPeriod('2026-Q2')).toEqual({
      period_type: 'quarterly',
      year: 2026,
      period: 2,
    })
    expect(vatFilingPeriodFromTaxPeriod('2026-03')).toEqual({
      period_type: 'monthly',
      year: 2026,
      period: 3,
    })
    // Fiscal-year labels of the yearly deadline, and malformed keys.
    expect(vatFilingPeriodFromTaxPeriod('2026')).toBeNull()
    expect(vatFilingPeriodFromTaxPeriod('2025/2026')).toBeNull()
    expect(vatFilingPeriodFromTaxPeriod('2026-13')).toBeNull()
    expect(vatFilingPeriodFromTaxPeriod('2026-Q5')).toBeNull()
    expect(vatFilingPeriodFromTaxPeriod(null)).toBeNull()
  })

  it('indexes by period key, newest filing winning a duplicate', () => {
    const older = record({ deadline_id: 'old', filed_on: '2026-08-01' })
    const newer = record({ deadline_id: 'new', filed_on: '2026-08-10' })
    const byPeriod = indexVatFilings([newer, older])
    expect(byPeriod.get(vatFilingKey('quarterly', 2026, 2))?.deadline_id).toBe('new')
    expect(byPeriod.size).toBe(1)
  })
})

describe('vatFilingPeriodEnd', () => {
  it('returns the last calendar day of the period', () => {
    expect(vatFilingPeriodEnd('monthly', 2028, 2)).toBe('2028-02-29')
    expect(vatFilingPeriodEnd('monthly', 2026, 12)).toBe('2026-12-31')
    expect(vatFilingPeriodEnd('quarterly', 2026, 2)).toBe('2026-06-30')
    expect(vatFilingPeriodEnd('quarterly', 2026, 4)).toBe('2026-12-31')
  })
})

describe('vatFilingDateProblem', () => {
  const today = '2026-09-17'

  it('refuses a period that is still running', () => {
    expect(
      vatFilingDateProblem(
        { periodType: 'quarterly', year: 2026, period: 3, filedOn: '2026-09-17' },
        today,
      ),
    ).toBe('VAT_FILING_PERIOD_NOT_ENDED')
  })

  it('refuses a filing date on or before the period end', () => {
    expect(
      vatFilingDateProblem(
        { periodType: 'quarterly', year: 2026, period: 2, filedOn: '2026-06-30' },
        today,
      ),
    ).toBe('VAT_FILING_DATE_BEFORE_PERIOD_END')
  })

  it('refuses a filing date in the future', () => {
    expect(
      vatFilingDateProblem(
        { periodType: 'quarterly', year: 2026, period: 2, filedOn: '2026-09-18' },
        today,
      ),
    ).toBe('VAT_FILING_DATE_IN_FUTURE')
  })

  it('accepts a date after the period end up to today', () => {
    expect(
      vatFilingDateProblem(
        { periodType: 'quarterly', year: 2026, period: 2, filedOn: '2026-07-01' },
        today,
      ),
    ).toBeNull()
    expect(
      vatFilingDateProblem(
        { periodType: 'monthly', year: 2026, period: 8, filedOn: today },
        today,
      ),
    ).toBeNull()
  })
})

describe('reference in notes', () => {
  it('round-trips a reference on its own prefixed line', () => {
    const notes = withVatFilingReference('Egen anteckning', 'KV-123')
    expect(notes).toBe('Egen anteckning\nSkatteverkets referens: KV-123')
    expect(parseVatFilingReference(notes)).toBe('KV-123')
  })

  it('replaces an existing reference line and keeps the user notes', () => {
    const notes = withVatFilingReference('Egen anteckning\nSkatteverkets referens: OLD', 'NEW')
    expect(notes).toBe('Egen anteckning\nSkatteverkets referens: NEW')
  })

  it('keeps the stored reference when undefined, clears it on null or blank', () => {
    const stored = 'Skatteverkets referens: KV-1'
    expect(withVatFilingReference(stored, undefined)).toBe(stored)
    expect(withVatFilingReference(stored, null)).toBeNull()
    expect(withVatFilingReference(stored, '   ')).toBeNull()
    expect(withVatFilingReference('Kvar', null)).toBe('Kvar')
  })

  it('reads nothing from notes without the prefix', () => {
    expect(parseVatFilingReference('Kom ihåg att betala')).toBeNull()
    expect(parseVatFilingReference(null)).toBeNull()
    expect(parseVatFilingReference('Skatteverkets referens: ')).toBeNull()
  })
})
