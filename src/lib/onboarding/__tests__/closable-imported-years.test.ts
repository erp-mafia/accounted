import { describe, expect, it, vi } from 'vitest'
import { closableImportedYears, closeYearsInOrder, type ClosableYearInput } from '../closable-imported-years'

function year(id: string, start: string, end: string, extra: Partial<ClosableYearInput> = {}): ClosableYearInput {
  return { id, name: `FY ${start.slice(0, 4)}`, period_start: start, period_end: end, is_closed: false, closed_externally: false, locked_at: null, ...extra }
}

describe('closableImportedYears', () => {
  const today = '2026-09-24'

  it('offers nothing with fewer than two years', () => {
    expect(closableImportedYears([year('a', '2025-01-01', '2025-12-31')], today)).toEqual([])
  })

  it('returns earlier ended years oldest first and never the latest year', () => {
    const periods = [
      year('c', '2026-01-01', '2026-12-31'),
      year('a', '2024-01-01', '2024-12-31'),
      year('b', '2025-01-01', '2025-12-31'),
    ]
    expect(closableImportedYears(periods, today).map((p) => p.id)).toEqual(['a', 'b'])
  })

  it('skips years that are closed, klarmarkerade, locked, or not yet ended', () => {
    const periods = [
      year('closed', '2021-01-01', '2021-12-31', { is_closed: true }),
      year('ext', '2022-01-01', '2022-12-31', { closed_externally: true }),
      year('locked', '2023-01-01', '2023-12-31', { locked_at: '2024-02-01T00:00:00Z' }),
      year('open', '2024-01-01', '2024-12-31'),
      year('broken', '2025-07-01', '2026-10-31'),
      year('latest', '2026-11-01', '2027-10-31'),
    ]
    expect(closableImportedYears(periods, today).map((p) => p.id)).toEqual(['open'])
  })
})

describe('closeYearsInOrder', () => {
  it('closes every year in the given order', async () => {
    const calls: string[] = []
    const closeOne = vi.fn(async (id: string) => {
      calls.push(id)
      return null
    })
    const result = await closeYearsInOrder([{ id: 'a', name: 'FY 2023' }, { id: 'b', name: 'FY 2024' }], closeOne)
    expect(calls).toEqual(['a', 'b'])
    expect(result).toEqual({ closed: ['FY 2023', 'FY 2024'], failed: null })
  })

  it('stops at the first refusal so no later year closes', async () => {
    const closeOne = vi.fn(async (id: string) => (id === 'b' ? 'obokförda transaktioner' : null))
    const result = await closeYearsInOrder(
      [{ id: 'a', name: 'FY 2023' }, { id: 'b', name: 'FY 2024' }, { id: 'c', name: 'FY 2025' }],
      closeOne,
    )
    expect(closeOne).toHaveBeenCalledTimes(2)
    expect(result).toEqual({ closed: ['FY 2023'], failed: { name: 'FY 2024', message: 'obokförda transaktioner' } })
  })

  it('treats a thrown error as a refusal', async () => {
    const result = await closeYearsInOrder([{ id: 'a', name: 'FY 2023' }], async () => {
      throw new Error('network')
    })
    expect(result).toEqual({ closed: [], failed: { name: 'FY 2023', message: 'network' } })
  })
})
