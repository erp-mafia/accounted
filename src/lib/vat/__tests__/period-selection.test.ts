import { describe, it, expect } from 'vitest'
import { resolveInitialVatPeriodSelection } from '../period-selection'

describe('resolveInitialVatPeriodSelection', () => {
  const today = new Date(2026, 7, 27) // 2026-08-27

  it('seeds yearly cadence from a yearly setting', () => {
    expect(
      resolveInitialVatPeriodSelection({ momsPeriod: 'yearly', over40m: false, today }),
    ).toEqual({ periodType: 'yearly', year: 2026, period: 1 })
  })

  it('seeds the most recently ended quarter for a quarterly setting', () => {
    expect(
      resolveInitialVatPeriodSelection({ momsPeriod: 'quarterly', over40m: false, today }),
    ).toEqual({ periodType: 'quarterly', year: 2026, period: 2 })
  })

  it('rolls a quarterly seed back across the year boundary in Q1', () => {
    expect(
      resolveInitialVatPeriodSelection({
        momsPeriod: 'quarterly',
        over40m: false,
        today: new Date(2026, 1, 10),
      }),
    ).toEqual({ periodType: 'quarterly', year: 2025, period: 4 })
  })

  it('seeds monthly filers from the deadline-aware default', () => {
    // 2026-08-06: June's declaration is due 17 Aug, so June is the open one.
    expect(
      resolveInitialVatPeriodSelection({
        momsPeriod: 'monthly',
        over40m: false,
        today: new Date(2026, 7, 6),
      }),
    ).toEqual({ periodType: 'monthly', year: 2026, period: 6 })
  })

  it('honors the over-40M monthly rule (always the most recently ended month)', () => {
    expect(
      resolveInitialVatPeriodSelection({
        momsPeriod: 'monthly',
        over40m: true,
        today: new Date(2026, 7, 6),
      }),
    ).toEqual({ periodType: 'monthly', year: 2026, period: 7 })
  })

  it('falls back to quarterly when moms_period is unset (state is gated, never rendered)', () => {
    expect(
      resolveInitialVatPeriodSelection({ momsPeriod: null, over40m: false, today }),
    ).toEqual({ periodType: 'quarterly', year: 2026, period: 2 })
  })
})
