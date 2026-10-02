import { describe, it, expect } from 'vitest'
import { getVatDeadlineForPeriod } from '@/lib/tax/deadline-config'
import {
  indexVatFilings,
  parseVatFilingReference,
  vatFilingDateProblem,
  vatFilingDeadlineType,
  vatFilingFiscalYearEndMonth,
  vatFilingKey,
  vatFilingLabelFiscalYearEndMonth,
  vatFilingPeriodEnd,
  vatFilingPeriodFromTaxPeriod,
  vatFilingPeriodRange,
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
    period_start: '2026-04-01',
    period_end: '2026-06-30',
    filed_on: '2026-08-10',
    source: 'manual',
    reference: null,
    ...overrides,
  }
}

describe('tax_period key mapping', () => {
  it('formats the generator key for every cadence', () => {
    expect(vatFilingTaxPeriod('monthly', 2026, 3, 12)).toBe('2026-03')
    expect(vatFilingTaxPeriod('quarterly', 2026, 2, 6)).toBe('2026-Q2')
    expect(vatFilingDeadlineType('monthly')).toBe('moms_monthly')
    expect(vatFilingDeadlineType('quarterly')).toBe('moms_quarterly')
    expect(vatFilingDeadlineType('yearly')).toBe('moms_yearly')
  })

  it('labels a yearly period by the räkenskapsår it names, as the deadline generator does', () => {
    // Calendar räkenskapsår 2026, and the broken one 2025-07-01 - 2026-06-30:
    // both are named by the year they end in.
    expect(vatFilingTaxPeriod('yearly', 2026, 1, 12)).toBe('2026')
    expect(vatFilingTaxPeriod('yearly', 2026, 1, 6)).toBe('2025/2026')
    // Parity with the generator's own label for the same company.
    for (const fiscal_year_start_month of [1, 5, 7, 12]) {
      const settings = {
        entity_type: 'aktiebolag' as const,
        fiscal_year_start_month,
        vat_taxable_base_over_40m: false,
        vat_has_eu_trade: false,
        vat_filing_method: 'electronic' as const,
      }
      expect(vatFilingTaxPeriod('yearly', 2027, 1, vatFilingFiscalYearEndMonth(settings))).toBe(
        getVatDeadlineForPeriod('yearly', 2027, 1, settings)?.period,
      )
    }
  })

  it('places the räkenskapsår from the company settings, an enskild firma always on the calendar year', () => {
    expect(vatFilingFiscalYearEndMonth({ entity_type: 'aktiebolag', fiscal_year_start_month: 7 })).toBe(6)
    expect(vatFilingFiscalYearEndMonth({ entity_type: 'aktiebolag', fiscal_year_start_month: 1 })).toBe(12)
    // BFL 3 kap 1 §: a fysisk person keeps the calendar year.
    expect(vatFilingFiscalYearEndMonth({ entity_type: 'enskild_firma', fiscal_year_start_month: 7 })).toBe(12)
    // No settings, or no start month: the column's default (January).
    expect(vatFilingFiscalYearEndMonth(null)).toBe(12)
    expect(vatFilingFiscalYearEndMonth({ entity_type: 'aktiebolag', fiscal_year_start_month: null })).toBe(12)
  })

  it('parses every cadence and rejects everything else', () => {
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
    // Fiscal-year labels of the yearly deadline name the year it ends in.
    expect(vatFilingPeriodFromTaxPeriod('2026')).toEqual({ period_type: 'yearly', year: 2026, period: 1 })
    expect(vatFilingPeriodFromTaxPeriod('2025/2026')).toEqual({
      period_type: 'yearly',
      year: 2026,
      period: 1,
    })
    // Malformed keys.
    expect(vatFilingPeriodFromTaxPeriod('2024/2026')).toBeNull()
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
    expect(vatFilingPeriodEnd('monthly', 2028, 2, 12)).toBe('2028-02-29')
    expect(vatFilingPeriodEnd('monthly', 2026, 12, 6)).toBe('2026-12-31')
    expect(vatFilingPeriodEnd('quarterly', 2026, 2, 12)).toBe('2026-06-30')
    expect(vatFilingPeriodEnd('quarterly', 2026, 4, 12)).toBe('2026-12-31')
    expect(vatFilingPeriodEnd('yearly', 2026, 1, 12)).toBe('2026-12-31')
    expect(vatFilingPeriodEnd('yearly', 2026, 1, 6)).toBe('2026-06-30')
    expect(vatFilingPeriodEnd('yearly', 2028, 1, 2)).toBe('2028-02-29')
  })
})

describe('vatFilingPeriodRange', () => {
  it('spans a month, a quarter, or the twelve months of a räkenskapsår', () => {
    expect(vatFilingPeriodRange('monthly', 2028, 2, 12)).toEqual({ start: '2028-02-01', end: '2028-02-29' })
    expect(vatFilingPeriodRange('quarterly', 2026, 4, 12)).toEqual({ start: '2026-10-01', end: '2026-12-31' })
    expect(vatFilingPeriodRange('yearly', 2026, 1, 12)).toEqual({ start: '2026-01-01', end: '2026-12-31' })
    // Broken räkenskapsår ending in June 2026, and one ending in April.
    expect(vatFilingPeriodRange('yearly', 2026, 1, 6)).toEqual({ start: '2025-07-01', end: '2026-06-30' })
    expect(vatFilingPeriodRange('yearly', 2027, 1, 4)).toEqual({ start: '2026-05-01', end: '2027-04-30' })
  })

  it('reads a stored calendar-year label as a calendar year whatever the company says today', () => {
    expect(vatFilingLabelFiscalYearEndMonth('2025', 6)).toBe(12)
    expect(vatFilingLabelFiscalYearEndMonth('2025/2026', 6)).toBe(6)
    expect(vatFilingLabelFiscalYearEndMonth('2026-Q2', 6)).toBe(6)
  })
})

describe('vatFilingDateProblem', () => {
  const today = '2026-09-17'

  it('refuses a period that is still running', () => {
    expect(
      vatFilingDateProblem(
        { periodType: 'quarterly', year: 2026, period: 3, filedOn: '2026-09-17' },
        today,
        12,
      ),
    ).toBe('VAT_FILING_PERIOD_NOT_ENDED')
  })

  it('refuses a filing date on or before the period end', () => {
    expect(
      vatFilingDateProblem(
        { periodType: 'quarterly', year: 2026, period: 2, filedOn: '2026-06-30' },
        today,
        12,
      ),
    ).toBe('VAT_FILING_DATE_BEFORE_PERIOD_END')
  })

  it('refuses a filing date in the future', () => {
    expect(
      vatFilingDateProblem(
        { periodType: 'quarterly', year: 2026, period: 2, filedOn: '2026-09-18' },
        today,
        12,
      ),
    ).toBe('VAT_FILING_DATE_IN_FUTURE')
  })

  it('accepts a date after the period end up to today', () => {
    expect(
      vatFilingDateProblem(
        { periodType: 'quarterly', year: 2026, period: 2, filedOn: '2026-07-01' },
        today,
        12,
      ),
    ).toBeNull()
    expect(
      vatFilingDateProblem(
        { periodType: 'monthly', year: 2026, period: 8, filedOn: today },
        today,
        12,
      ),
    ).toBeNull()
  })
})

describe('vatFilingDateProblem for a räkenskapsår', () => {
  it('judges a broken räkenskapsår by its own last day, not December', () => {
    // Räkenskapsår 2025-07-01 - 2026-06-30, filed in August 2026.
    const input = { periodType: 'yearly' as const, year: 2026, period: 1, filedOn: '2026-08-20' }
    expect(vatFilingDateProblem(input, '2026-09-17', 6)).toBeNull()
    // The same key under a calendar räkenskapsår has not ended yet.
    expect(vatFilingDateProblem(input, '2026-09-17', 12)).toBe('VAT_FILING_PERIOD_NOT_ENDED')
    expect(vatFilingDateProblem({ ...input, filedOn: '2026-06-30' }, '2026-09-17', 6)).toBe(
      'VAT_FILING_DATE_BEFORE_PERIOD_END',
    )
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
