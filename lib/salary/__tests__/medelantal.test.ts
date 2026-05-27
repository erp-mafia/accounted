import { describe, it, expect } from 'vitest'
import { computeMedelantalAnstallda } from '../medelantal'

describe('computeMedelantalAnstallda', () => {
  const START = '2025-01-01'
  const END = '2025-12-31'

  it('returns 0 for empty list', () => {
    expect(computeMedelantalAnstallda([], START, END)).toBe(0)
  })

  it('counts a full-year, full-time employee as 1', () => {
    expect(
      computeMedelantalAnstallda(
        [{ employment_start: '2024-01-01', employment_end: null, employment_degree: 100 }],
        START,
        END,
      ),
    ).toBe(1)
  })

  it('counts a half-year hire (Jul 1) as 0.5 → rounds to 1', () => {
    // 184 / 365 ≈ 0.504 → rounds to 1
    expect(
      computeMedelantalAnstallda(
        [{ employment_start: '2025-07-01', employment_end: null, employment_degree: 100 }],
        START,
        END,
      ),
    ).toBe(1)
  })

  it('counts a 50% full-year employee as 0.5 → rounds to 1', () => {
    // 365 * 0.5 / 365 = 0.5 → Math.round(0.5) = 1 in JS (banker's round of .5 goes up via Math.round)
    expect(
      computeMedelantalAnstallda(
        [{ employment_start: '2024-01-01', employment_end: null, employment_degree: 50 }],
        START,
        END,
      ),
    ).toBe(1)
  })

  it('counts a terminated employee correctly', () => {
    // Mar 1 - Aug 31 = 184 days, 100% → 184/365 = 0.504 → 1
    expect(
      computeMedelantalAnstallda(
        [
          {
            employment_start: '2025-03-01',
            employment_end: '2025-08-31',
            employment_degree: 100,
          },
        ],
        START,
        END,
      ),
    ).toBe(1)
  })

  it('weights by employment_degree on a partial year', () => {
    // Mar 1 - Aug 31 (184 days) at 80% → 147.2/365 ≈ 0.403 → 0
    expect(
      computeMedelantalAnstallda(
        [
          {
            employment_start: '2025-03-01',
            employment_end: '2025-08-31',
            employment_degree: 80,
          },
        ],
        START,
        END,
      ),
    ).toBe(0)
  })

  it('sums across multiple employees', () => {
    // Two full-time employees all year + one half-year hire ≈ 2.5 → 3
    expect(
      computeMedelantalAnstallda(
        [
          { employment_start: '2024-01-01', employment_end: null, employment_degree: 100 },
          { employment_start: '2024-01-01', employment_end: null, employment_degree: 100 },
          { employment_start: '2025-07-01', employment_end: null, employment_degree: 100 },
        ],
        START,
        END,
      ),
    ).toBe(3)
  })

  it('clamps employment_degree to 0..100', () => {
    expect(
      computeMedelantalAnstallda(
        [
          { employment_start: '2024-01-01', employment_end: null, employment_degree: 200 },
        ],
        START,
        END,
      ),
    ).toBe(1)
  })

  it('ignores employees terminated before period start', () => {
    expect(
      computeMedelantalAnstallda(
        [
          {
            employment_start: '2024-01-01',
            employment_end: '2024-12-31',
            employment_degree: 100,
          },
        ],
        START,
        END,
      ),
    ).toBe(0)
  })

  it('ignores employees hired after period end', () => {
    expect(
      computeMedelantalAnstallda(
        [
          { employment_start: '2026-01-01', employment_end: null, employment_degree: 100 },
        ],
        START,
        END,
      ),
    ).toBe(0)
  })

  it('handles a brutet räkenskapsår (Jul 1 - Jun 30)', () => {
    expect(
      computeMedelantalAnstallda(
        [
          { employment_start: '2024-01-01', employment_end: null, employment_degree: 100 },
        ],
        '2025-07-01',
        '2026-06-30',
      ),
    ).toBe(1)
  })

  it('returns 0 for period with zero length', () => {
    expect(
      computeMedelantalAnstallda(
        [{ employment_start: '2024-01-01', employment_end: null, employment_degree: 100 }],
        '2025-01-01',
        '2024-12-31', // reversed
      ),
    ).toBe(0)
  })
})
