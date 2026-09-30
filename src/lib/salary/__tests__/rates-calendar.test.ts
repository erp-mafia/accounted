/**
 * Calendar tripwire for the yearly figures that live in code. Fails CI once a
 * due date (lib/salary/rates-calendar.ts) has passed without next year's
 * figures, so a missing year is found in December, not by a January payroll.
 * The salary_payroll_config rows are checked against a real database in
 * tests/pg/payroll-rates-calendar.pg.test.ts.
 *
 * When this fails: add next year's figures from their official sources (the
 * regeluppdat loop's 2027 ticket lists them), never by copying last year's.
 */
import { describe, expect, it } from 'vitest'
import { CAPITALIZATION_THRESHOLD_YEARS } from '@/lib/bookkeeping/mapping-engine'
import { FALLBACK_TAX_TABLE_YEARS } from '../tax-tables-fallback'
import {
  PAYROLL_RATES_DUE,
  TAX_TABLE_FALLBACK_DUE,
  isDue,
  requiredYears,
} from '../rates-calendar'

describe('rates calendar', () => {
  it('asks for next year only once the due date has passed (UTC)', () => {
    const due = { month: 12, day: 10 }
    expect(requiredYears(due, new Date('2026-12-09T23:59:59Z'))).toEqual([2026])
    expect(requiredYears(due, new Date('2026-12-10T00:00:00Z'))).toEqual([2026, 2027])
    expect(requiredYears(due, new Date('2027-01-02T08:00:00Z'))).toEqual([2027])
    expect(isDue(due, new Date('2026-06-01T00:00:00Z'))).toBe(false)
  })

  it('keeps every due date before the year turns', () => {
    for (const due of [PAYROLL_RATES_DUE, TAX_TABLE_FALLBACK_DUE]) {
      expect(isDue(due, new Date('2026-12-31T00:00:00Z'))).toBe(true)
    }
  })
})

describe('yearly figures in code', () => {
  const now = new Date()

  it('has the half-prisbasbelopp capitalization threshold for every required year', () => {
    for (const year of requiredYears(PAYROLL_RATES_DUE, now)) {
      expect(
        CAPITALIZATION_THRESHOLD_YEARS.has(year),
        `lib/bookkeeping/mapping-engine.ts PRISBASBELOPP_HALVES has no ${year}`,
      ).toBe(true)
    }
  })

  it('bundles the fallback tax tables for every required year', () => {
    for (const year of requiredYears(TAX_TABLE_FALLBACK_DUE, now)) {
      expect(
        FALLBACK_TAX_TABLE_YEARS.has(year),
        `lib/salary/tax-tables-fallback.ts has no ${year}: npx tsx scripts/import-tax-tables.ts --year ${year}`,
      ).toBe(true)
    }
  })
})
