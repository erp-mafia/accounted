import { describe, it, expect } from 'vitest'
import { parseStoredVatCadence, resolveInitialVatPeriodSelection } from '../period-selection'

describe('parseStoredVatCadence', () => {
  it('parses a valid stored cadence', () => {
    expect(
      parseStoredVatCadence(JSON.stringify({ periodType: 'yearly', momsPeriod: 'quarterly' })),
    ).toEqual({ periodType: 'yearly', momsPeriod: 'quarterly' })
  })

  it('accepts a null momsPeriod (cadence chosen before the setting existed)', () => {
    expect(
      parseStoredVatCadence(JSON.stringify({ periodType: 'monthly', momsPeriod: null })),
    ).toEqual({ periodType: 'monthly', momsPeriod: null })
  })

  it('returns null for missing, malformed, or non-object input', () => {
    expect(parseStoredVatCadence(null)).toBeNull()
    expect(parseStoredVatCadence('')).toBeNull()
    expect(parseStoredVatCadence('not json')).toBeNull()
    expect(parseStoredVatCadence('42')).toBeNull()
    expect(parseStoredVatCadence('null')).toBeNull()
  })

  it('rejects unknown period types', () => {
    expect(
      parseStoredVatCadence(JSON.stringify({ periodType: 'weekly', momsPeriod: 'quarterly' })),
    ).toBeNull()
    expect(
      parseStoredVatCadence(JSON.stringify({ periodType: 'yearly', momsPeriod: 'weekly' })),
    ).toBeNull()
    expect(parseStoredVatCadence(JSON.stringify({ momsPeriod: 'quarterly' }))).toBeNull()
  })
})

describe('resolveInitialVatPeriodSelection', () => {
  const today = new Date(2026, 7, 27) // 2026-08-27

  it('restores a stored cadence chosen under the current setting', () => {
    expect(
      resolveInitialVatPeriodSelection({
        stored: { periodType: 'yearly', momsPeriod: 'quarterly' },
        momsPeriod: 'quarterly',
        over40m: false,
        today,
      }),
    ).toEqual({ periodType: 'yearly', year: 2026, period: 1 })
  })

  it('re-seeds the concrete period for a restored monthly/quarterly cadence', () => {
    // Restored cadence quarterly: the period is NOT restored, it re-derives
    // to the most recently ended quarter (Q2 on 2026-08-27).
    expect(
      resolveInitialVatPeriodSelection({
        stored: { periodType: 'quarterly', momsPeriod: 'yearly' },
        momsPeriod: 'yearly',
        over40m: false,
        today,
      }),
    ).toEqual({ periodType: 'quarterly', year: 2026, period: 2 })
  })

  it('discards a stored cadence when moms_period changed since it was chosen', () => {
    expect(
      resolveInitialVatPeriodSelection({
        stored: { periodType: 'quarterly', momsPeriod: 'quarterly' },
        momsPeriod: 'yearly',
        over40m: false,
        today,
      }),
    ).toEqual({ periodType: 'yearly', year: 2026, period: 1 })
  })

  it('seeds yearly cadence from a yearly setting with no stored cadence', () => {
    expect(
      resolveInitialVatPeriodSelection({
        stored: null,
        momsPeriod: 'yearly',
        over40m: false,
        today,
      }),
    ).toEqual({ periodType: 'yearly', year: 2026, period: 1 })
  })

  it('seeds the most recently ended quarter for a quarterly setting', () => {
    expect(
      resolveInitialVatPeriodSelection({
        stored: null,
        momsPeriod: 'quarterly',
        over40m: false,
        today,
      }),
    ).toEqual({ periodType: 'quarterly', year: 2026, period: 2 })
  })

  it('rolls a quarterly seed back across the year boundary in Q1', () => {
    expect(
      resolveInitialVatPeriodSelection({
        stored: null,
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
        stored: null,
        momsPeriod: 'monthly',
        over40m: false,
        today: new Date(2026, 7, 6),
      }),
    ).toEqual({ periodType: 'monthly', year: 2026, period: 6 })
  })

  it('falls back to quarterly when moms_period is unset (state is gated, never rendered)', () => {
    expect(
      resolveInitialVatPeriodSelection({
        stored: null,
        momsPeriod: null,
        over40m: false,
        today,
      }),
    ).toEqual({ periodType: 'quarterly', year: 2026, period: 2 })
  })

  it('does not restore a cadence stored under momsPeriod null once a setting exists', () => {
    expect(
      resolveInitialVatPeriodSelection({
        stored: { periodType: 'monthly', momsPeriod: null },
        momsPeriod: 'yearly',
        over40m: false,
        today,
      }),
    ).toEqual({ periodType: 'yearly', year: 2026, period: 1 })
  })
})
