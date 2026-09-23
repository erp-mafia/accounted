import { describe, it, expect } from 'vitest'
import { prepareFiscalPeriods, resolveInitialFiscalScope } from '../fiscal-scope'
import { ALL_YEARS_VALUE } from '@/components/common/fiscal-year-storage'
import type { FiscalPeriod } from '@/types'

const period = (id: string, start: string, end: string) =>
  ({ id, name: id, period_start: start, period_end: end }) as unknown as FiscalPeriod

const p2024 = period('p2024', '2024-01-01', '2024-12-31')
const p2025 = period('p2025', '2025-01-01', '2025-12-31')
const p2026 = period('p2026', '2026-01-01', '2026-12-31')
const p2027 = period('p2027', '2027-01-01', '2027-12-31')
const TODAY = '2026-08-26'

describe('prepareFiscalPeriods', () => {
  it('sorts newest first and can hide periods that have not started', () => {
    const all = prepareFiscalPeriods([p2024, p2027, p2026, p2025], false, TODAY)
    expect(all.map((p) => p.id)).toEqual(['p2027', 'p2026', 'p2025', 'p2024'])
    const started = prepareFiscalPeriods([p2024, p2027, p2026, p2025], true, TODAY)
    expect(started.map((p) => p.id)).toEqual(['p2026', 'p2025', 'p2024'])
  })

  it('does not mutate the input', () => {
    const input = [p2024, p2026]
    prepareFiscalPeriods(input, false, TODAY)
    expect(input.map((p) => p.id)).toEqual(['p2024', 'p2026'])
  })
})

describe('resolveInitialFiscalScope', () => {
  const periods = prepareFiscalPeriods([p2024, p2025, p2026], false, TODAY)

  it('restores a persisted period that still exists', () => {
    expect(resolveInitialFiscalScope(periods, 'p2025', { includeAllOption: true })).toEqual({
      periodId: 'p2025',
      period: p2025,
    })
  })

  it('ignores a stale persisted id and falls back per the surface', () => {
    expect(resolveInitialFiscalScope(periods, 'gone', { includeAllOption: true })).toBeNull()
    expect(resolveInitialFiscalScope(periods, 'gone', { includeAllOption: false })).toEqual({
      periodId: 'p2026',
      period: p2026,
    })
  })

  it('honours an explicit "all years" only where the surface allows it', () => {
    expect(resolveInitialFiscalScope(periods, ALL_YEARS_VALUE, { includeAllOption: true })).toEqual({
      periodId: null,
      period: null,
    })
    expect(resolveInitialFiscalScope(periods, ALL_YEARS_VALUE, { includeAllOption: false })).toEqual({
      periodId: 'p2026',
      period: p2026,
    })
  })

  it('with nothing stored: all-years surfaces stay unfiltered, others pick the newest', () => {
    expect(resolveInitialFiscalScope(periods, null, { includeAllOption: true })).toBeNull()
    expect(resolveInitialFiscalScope(periods, null, { includeAllOption: false })).toEqual({
      periodId: 'p2026',
      period: p2026,
    })
  })

  it('preferLatestEnded opens on the most recently ended period and ignores the stored choice', () => {
    expect(
      resolveInitialFiscalScope(periods, 'p2024', { includeAllOption: false, preferLatestEnded: true, today: TODAY }),
    ).toEqual({ periodId: 'p2025', period: p2025 })
  })

  it('preferLatestEnded falls back to the newest period when none has ended', () => {
    const onlyCurrent = prepareFiscalPeriods([p2026], false, TODAY)
    expect(
      resolveInitialFiscalScope(onlyCurrent, null, { includeAllOption: false, preferLatestEnded: true, today: TODAY }),
    ).toEqual({ periodId: 'p2026', period: p2026 })
  })

  it('returns null for an empty list on every path', () => {
    expect(resolveInitialFiscalScope([], null, { includeAllOption: false })).toBeNull()
    expect(resolveInitialFiscalScope([], ALL_YEARS_VALUE, { includeAllOption: false })).toBeNull()
    expect(resolveInitialFiscalScope([], 'x', { includeAllOption: false, preferLatestEnded: true })).toBeNull()
    expect(resolveInitialFiscalScope([], ALL_YEARS_VALUE, { includeAllOption: true })).toEqual({
      periodId: null,
      period: null,
    })
  })
})
