import { describe, it, expect } from 'vitest'
import {
  computeSuggestedPeriod,
  suggestSeedDate,
  resolveCurrentPeriodId,
} from '../suggest-fiscal-period'

type Range = { period_start: string; period_end: string }

const FY2024: Range = { period_start: '2024-01-01', period_end: '2024-12-31' }
const FY2026: Range = { period_start: '2026-01-01', period_end: '2026-12-31' }

describe('computeSuggestedPeriod', () => {
  it('suggests a calendar year around the entry date when there are no periods', () => {
    expect(computeSuggestedPeriod('2025-06-15', [])).toEqual({
      name: 'Räkenskapsår 2025',
      period_start: '2025-01-01',
      period_end: '2025-12-31',
    })
  })

  it('suggests a backfill year before the earliest period', () => {
    expect(computeSuggestedPeriod('2025-06-15', [FY2026])).toEqual({
      name: 'Räkenskapsår 2025',
      period_start: '2025-01-01',
      period_end: '2025-12-31',
    })
  })

  it('suggests the missing year when the entry date is in an interior gap', () => {
    // FY 2024 + FY 2026 exist, 2025 is the hole (interior-gap scenario).
    expect(computeSuggestedPeriod('2025-06-15', [FY2024, FY2026])).toEqual({
      name: 'Räkenskapsår 2025',
      period_start: '2025-01-01',
      period_end: '2025-12-31',
    })
  })

  it('caps the gap suggestion so it never overlaps the right neighbour', () => {
    // A six-month hole (Jan-Jun 2025) before a short FY 2025 H2 period.
    const fy2025h2: Range = { period_start: '2025-07-01', period_end: '2025-12-31' }
    expect(computeSuggestedPeriod('2025-03-15', [FY2024, fy2025h2])).toEqual({
      name: 'Räkenskapsår 2025',
      period_start: '2025-01-01',
      period_end: '2025-06-30',
    })
  })

  it('suggests the next forward year after the latest period', () => {
    expect(computeSuggestedPeriod('2025-06-15', [FY2024])).toEqual({
      name: 'Räkenskapsår 2025',
      period_start: '2025-01-01',
      period_end: '2025-12-31',
    })
  })
})

describe('suggestSeedDate', () => {
  const today = '2026-06-16'

  it('returns today when there are no periods', () => {
    expect(suggestSeedDate([], today)).toBe('2026-06-16')
  })

  it('returns the start of the earliest gap when one exists', () => {
    expect(suggestSeedDate([FY2024, FY2026], today)).toBe('2025-01-01')
  })

  it('returns the day after the latest period when there is no gap', () => {
    const fy2025: Range = { period_start: '2025-01-01', period_end: '2025-12-31' }
    expect(suggestSeedDate([FY2024, fy2025], today)).toBe('2026-01-01')
  })

  it('returns the day after the only period for a single period', () => {
    expect(suggestSeedDate([FY2024], today)).toBe('2025-01-01')
  })
})

describe('resolveCurrentPeriodId', () => {
  const P2024 = { id: 'p2024', period_start: '2024-01-01', period_end: '2024-12-31' }
  const P2025 = { id: 'p2025', period_start: '2025-01-01', period_end: '2025-12-31' }
  const P2026 = { id: 'p2026', period_start: '2026-01-01', period_end: '2026-12-31' }

  it('returns null when there are no periods', () => {
    expect(resolveCurrentPeriodId([], '2026-06-29')).toBeNull()
  })

  it('returns the period that contains today', () => {
    expect(resolveCurrentPeriodId([P2024, P2025, P2026], '2026-06-29')).toBe('p2026')
  })

  it('is order-independent', () => {
    expect(resolveCurrentPeriodId([P2026, P2024, P2025], '2025-03-01')).toBe('p2025')
  })

  it('falls back to the most recent started period when today sits in a gap after the last year', () => {
    // Today is in 2027 but only periods up to 2026 exist (next year not created yet).
    expect(resolveCurrentPeriodId([P2024, P2025, P2026], '2027-02-15')).toBe('p2026')
  })

  it('falls back to the earliest period when every period is still upcoming', () => {
    expect(resolveCurrentPeriodId([P2025, P2026], '2024-06-01')).toBe('p2025')
  })
})
