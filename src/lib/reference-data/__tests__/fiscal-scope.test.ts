import { describe, it, expect } from 'vitest'
import { closableFiscalPeriods, effectiveFiscalScope, prepareFiscalPeriods, resolveAppFiscalChoice, resolveInitialFiscalScope } from '../fiscal-scope'
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

describe('resolveAppFiscalChoice (the sidebar year)', () => {
  const newestFirst = [p2027, p2026, p2025, p2024]

  it('opens on the newest started year when nothing is stored', () => {
    expect(resolveAppFiscalChoice(newestFirst, null, TODAY)).toBe('p2026')
  })

  it('keeps a stored year and a stored "all years"', () => {
    expect(resolveAppFiscalChoice(newestFirst, 'p2024', TODAY)).toBe('p2024')
    expect(resolveAppFiscalChoice(newestFirst, ALL_YEARS_VALUE, TODAY)).toBeNull()
  })

  it('drops a stored year that no longer exists', () => {
    expect(resolveAppFiscalChoice(newestFirst, 'gone', TODAY)).toBe('p2026')
  })

  it('opens on the only period even when it starts later', () => {
    expect(resolveAppFiscalChoice([p2027], null, TODAY)).toBe('p2027')
    expect(resolveAppFiscalChoice([], null, TODAY)).toBeNull()
  })
})

describe('effectiveFiscalScope (what a page uses)', () => {
  const newestFirst = [p2027, p2026, p2025, p2024]

  it('passes the choice through where it fits', () => {
    expect(effectiveFiscalScope(newestFirst, 'p2025', { today: TODAY }).periodId).toBe('p2025')
    expect(effectiveFiscalScope(newestFirst, null, { today: TODAY })).toEqual({ periodId: null, period: null })
  })

  it('gives a one-year surface the current year for "all years"', () => {
    expect(effectiveFiscalScope(newestFirst, null, { allowAll: false, today: TODAY }).periodId).toBe('p2026')
  })

  it('gives a started-only surface the current year for a future pick', () => {
    expect(effectiveFiscalScope(newestFirst, 'p2027', { hideFuture: true, today: TODAY }).periodId).toBe('p2026')
    expect(effectiveFiscalScope(newestFirst, 'p2027', { today: TODAY }).periodId).toBe('p2027')
  })

  it('falls back to the current year for an unknown id, and to nothing without periods', () => {
    expect(effectiveFiscalScope(newestFirst, 'gone', { today: TODAY }).periodId).toBe('p2026')
    expect(effectiveFiscalScope([], 'gone', { allowAll: false, today: TODAY })).toEqual({ periodId: null, period: null })
  })
})

describe('closableFiscalPeriods (what a year-end flow may close)', () => {
  it('keeps ended years that are not closed and have no closing entry, oldest first', () => {
    const closed = { ...period('c', '2023-01-01', '2023-12-31'), is_closed: true }
    const withEntry = { ...period('e', '2022-01-01', '2022-12-31'), closing_entry_id: 'je-1' }
    const result = closableFiscalPeriods([p2025, p2024, closed, withEntry, p2026], '2026-06-15')
    expect(result.map((p) => p.id)).toEqual([p2024.id, p2025.id])
  })

  it('keeps a year open on its last day, and closable the day after (hasEnded)', () => {
    expect(closableFiscalPeriods([p2025], p2025.period_end)).toEqual([])
    expect(closableFiscalPeriods([p2025], '2026-01-01').map((p) => p.id)).toEqual([p2025.id])
  })
})
