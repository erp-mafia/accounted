import { describe, it, expect } from 'vitest'
import { describeFiscalYearGap, findFiscalYearGaps } from '../fiscal-year-gaps'

const p = (id: string, start: string, end: string) => ({ id, name: `Räkenskapsår ${start.slice(0, 4)}`, period_start: start, period_end: end })

describe('findFiscalYearGaps', () => {
  it('finds a missing calendar year between two periods regardless of input order', () => {
    const gaps = findFiscalYearGaps([p('c', '2026-01-01', '2026-12-31'), p('a', '2024-01-01', '2024-12-31')])
    expect(gaps).toHaveLength(1)
    expect(gaps[0]).toMatchObject({ missing_from: '2025-01-01', missing_to: '2025-12-31' })
    expect(gaps[0].after.id).toBe('a')
    expect(gaps[0].before.id).toBe('c')
  })

  it('reports nothing for adjacent periods, broken years included, and for a single period', () => {
    expect(findFiscalYearGaps([p('a', '2024-07-01', '2025-06-30'), p('b', '2025-07-01', '2026-06-30')])).toEqual([])
    expect(findFiscalYearGaps([p('a', '2024-01-01', '2024-12-31')])).toEqual([])
    expect(findFiscalYearGaps([])).toEqual([])
  })

  it('ignores overlaps and finds every hole in a longer chain', () => {
    const gaps = findFiscalYearGaps([
      p('a', '2021-01-01', '2021-12-31'),
      p('b', '2021-06-01', '2022-05-31'),
      p('c', '2024-01-01', '2024-12-31'),
      p('d', '2027-01-01', '2027-12-31'),
    ])
    expect(gaps.map((g) => [g.missing_from, g.missing_to])).toEqual([
      ['2022-06-01', '2023-12-31'],
      ['2025-01-01', '2026-12-31'],
    ])
  })

  it('describes a gap in Swedish with both neighbours named', () => {
    const [gap] = findFiscalYearGaps([p('a', '2024-01-01', '2024-12-31'), p('c', '2026-01-01', '2026-12-31')])
    expect(describeFiscalYearGap(gap)).toMatch(/2025-01-01 till 2025-12-31 \(mellan Räkenskapsår 2024 och Räkenskapsår 2026\)/)
  })
})
