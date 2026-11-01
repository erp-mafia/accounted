import { describe, it, expect, vi } from 'vitest'
import { createRowsMockSupabase } from '@/tests/helpers'
import { fiscalPeriodForVatYear } from '@/lib/reports/period-dates'
import { resolvePeriodDates } from '@/lib/reports/vat-declaration'
import { resolveInitialVatPeriodSelection } from '../period-selection'
import type { VatPeriodType } from '@/types'

/**
 * Issues #2746, #2786: a filed period must not reopen on every visit. The
 * seed steps past filed periods up to (never past) the period running today,
 * for every cadence, helårsmoms included.
 */
const filedSet =
  (keys: string[]) =>
  (periodType: VatPeriodType, year: number, period: number) =>
    keys.includes(`${periodType}:${year}:${period}`)

describe('resolveInitialVatPeriodSelection with filed periods', () => {
  it('opens the next quarter once the most recently ended one is filed', () => {
    // 2026-09-17: Q2 ended and was filed in August; Q3 is running.
    expect(
      resolveInitialVatPeriodSelection({
        momsPeriod: 'quarterly',
        over40m: false,
        today: new Date(2026, 8, 17),
        isFiled: filedSet(['quarterly:2026:2']),
      }),
    ).toEqual({ periodType: 'quarterly', year: 2026, period: 3 })
  })

  it('stays on the ended quarter while it is not filed', () => {
    expect(
      resolveInitialVatPeriodSelection({
        momsPeriod: 'quarterly',
        over40m: false,
        today: new Date(2026, 8, 17),
        isFiled: filedSet(['quarterly:2026:1']),
      }),
    ).toEqual({ periodType: 'quarterly', year: 2026, period: 2 })
  })

  it('never steps past the running period, whatever the predicate says', () => {
    expect(
      resolveInitialVatPeriodSelection({
        momsPeriod: 'quarterly',
        over40m: false,
        today: new Date(2026, 8, 17),
        isFiled: () => true,
      }),
    ).toEqual({ periodType: 'quarterly', year: 2026, period: 3 })
  })

  it('rolls into the new year when Q4 was filed in January', () => {
    expect(
      resolveInitialVatPeriodSelection({
        momsPeriod: 'quarterly',
        over40m: false,
        today: new Date(2026, 0, 20),
        isFiled: filedSet(['quarterly:2025:4']),
      }),
    ).toEqual({ periodType: 'quarterly', year: 2026, period: 1 })
  })

  it('steps a monthly filer from a filed M-2 to M-1 only', () => {
    // 2026-08-06: June is the default (due 17 Aug). June filed, July not.
    expect(
      resolveInitialVatPeriodSelection({
        momsPeriod: 'monthly',
        over40m: false,
        today: new Date(2026, 7, 6),
        isFiled: filedSet(['monthly:2026:6']),
      }),
    ).toEqual({ periodType: 'monthly', year: 2026, period: 7 })
  })

  it('steps past two filed months up to the running month', () => {
    expect(
      resolveInitialVatPeriodSelection({
        momsPeriod: 'monthly',
        over40m: false,
        today: new Date(2026, 7, 6),
        isFiled: filedSet(['monthly:2026:6', 'monthly:2026:7']),
      }),
    ).toEqual({ periodType: 'monthly', year: 2026, period: 8 })
  })

  it('opens the running räkenskapsår once the last one is filed (calendar year)', () => {
    // 2026-09-17: räkenskapsår 2025 ended and was filed; 2026 is running.
    expect(
      resolveInitialVatPeriodSelection({
        momsPeriod: 'yearly',
        over40m: false,
        fiscalYearEndMonth: 12,
        today: new Date(2026, 8, 17),
        isFiled: filedSet(['yearly:2025:1']),
      }),
    ).toEqual({ periodType: 'yearly', year: 2026, period: 1 })
  })

  it('stays on the ended räkenskapsår while it is not filed (calendar year)', () => {
    expect(
      resolveInitialVatPeriodSelection({
        momsPeriod: 'yearly',
        over40m: false,
        fiscalYearEndMonth: 12,
        today: new Date(2026, 8, 17),
        isFiled: filedSet(['yearly:2024:1']),
      }),
    ).toEqual({ periodType: 'yearly', year: 2025, period: 1 })
  })

  it('names a broken räkenskapsår by the year it ends and steps past it once filed', () => {
    // Räkenskapsår July-June. On 2026-09-17 the year ending 2026-06-30 has
    // ended (key 2026) and the one ending 2027-06-30 is running (key 2027).
    const base = {
      momsPeriod: 'yearly' as const,
      over40m: false,
      fiscalYearEndMonth: 6,
      today: new Date(2026, 8, 17),
    }
    expect(resolveInitialVatPeriodSelection(base)).toEqual({ periodType: 'yearly', year: 2026, period: 1 })
    expect(
      resolveInitialVatPeriodSelection({ ...base, isFiled: filedSet(['yearly:2026:1']) }),
    ).toEqual({ periodType: 'yearly', year: 2027, period: 1 })
    // On the räkenskapsår's last day it is still running.
    expect(
      resolveInitialVatPeriodSelection({ ...base, today: new Date(2026, 5, 30) }),
    ).toEqual({ periodType: 'yearly', year: 2025, period: 1 })
  })

  it('never steps a yearly filer past the running räkenskapsår', () => {
    expect(
      resolveInitialVatPeriodSelection({
        momsPeriod: 'yearly',
        over40m: false,
        fiscalYearEndMonth: 12,
        today: new Date(2026, 8, 17),
        isFiled: () => true,
      }),
    ).toEqual({ periodType: 'yearly', year: 2026, period: 1 })
  })

  it('behaves as before when no predicate is given', () => {
    expect(
      resolveInitialVatPeriodSelection({
        momsPeriod: 'quarterly',
        over40m: false,
        today: new Date(2026, 8, 17),
      }),
    ).toEqual({ periodType: 'quarterly', year: 2026, period: 2 })
  })
})

describe('fiscalPeriodForVatYear', () => {
  const periods = [
    { id: 'fy-2025', period_start: '2024-07-01', period_end: '2025-06-30' },
    { id: 'fy-2026', period_start: '2025-07-01', period_end: '2026-06-30' },
    { id: 'fy-2027', period_start: '2026-07-01', period_end: '2027-06-30' },
  ]

  it('finds the räkenskapsår that ends in the key year', () => {
    expect(fiscalPeriodForVatYear(periods, 2026, '2026-09-17')?.id).toBe('fy-2026')
    expect(fiscalPeriodForVatYear(periods, 2027, '2026-09-17')?.id).toBe('fy-2027')
  })

  it('skips a räkenskapsår that has not started and answers null when none matches', () => {
    expect(fiscalPeriodForVatYear(periods, 2027, '2026-06-30')).toBeNull()
    expect(fiscalPeriodForVatYear(periods, 2030, '2026-09-17')).toBeNull()
  })

  it('takes the later one when an omläggning ends two in the same year', () => {
    const changed = [
      { id: 'broken', period_start: '2025-05-01', period_end: '2026-04-30' },
      { id: 'short', period_start: '2026-05-01', period_end: '2026-12-31' },
    ]
    expect(fiscalPeriodForVatYear(changed, 2026, '2027-01-10')?.id).toBe('short')
  })

  it('is the year the declaration reads, when an omläggning ends two in one calendar year', async () => {
    const changed = [
      { id: 'first', company_id: 'c', period_start: '2026-01-01', period_end: '2026-06-30' },
      { id: 'second', company_id: 'c', period_start: '2026-07-01', period_end: '2026-12-31' },
    ]
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      for (const today of ['2026-03-01', '2026-09-01', '2027-02-01']) {
        vi.setSystemTime(new Date(`${today}T10:00:00Z`))
        const { supabase } = createRowsMockSupabase({ fiscal_periods: changed })
        const declared = await resolvePeriodDates(supabase as never, 'c', 'yearly', 2026, 1)
        const picked = fiscalPeriodForVatYear(changed, 2026, today)
        expect({ start: declared.start, end: declared.end }).toEqual({
          start: picked?.period_start,
          end: picked?.period_end,
        })
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('names a year not started when the declaration asks for it, but the picker does not list it', async () => {
    const broken = [{ id: 'next', company_id: 'c', period_start: '2026-07-01', period_end: '2027-06-30' }]
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2026-03-01T10:00:00Z'))
      const { supabase } = createRowsMockSupabase({ fiscal_periods: broken })
      await expect(resolvePeriodDates(supabase as never, 'c', 'yearly', 2027, 1)).resolves.toMatchObject({
        start: '2026-07-01',
        end: '2027-06-30',
        source: 'fiscal_period',
      })
      expect(fiscalPeriodForVatYear(broken, 2027, '2026-03-01')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
