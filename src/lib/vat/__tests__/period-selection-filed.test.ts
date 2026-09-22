import { describe, it, expect } from 'vitest'
import { resolveInitialVatPeriodSelection } from '../period-selection'

/**
 * Issue #2746: a filed period must not reopen on every visit. The seed steps
 * past filed periods up to (never past) the period running today.
 */
const filedSet =
  (keys: string[]) =>
  (periodType: 'monthly' | 'quarterly', year: number, period: number) =>
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

  it('leaves the yearly cadence alone', () => {
    expect(
      resolveInitialVatPeriodSelection({
        momsPeriod: 'yearly',
        over40m: false,
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
