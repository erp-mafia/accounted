import { describe, it, expect } from 'vitest'
import { resolvePreset } from '@/lib/reports/report-range-preset'

describe('resolvePreset: last_quarter (Förra kvartalet)', () => {
  it('is the previous calendar quarter, rolling back into last year from Q1', () => {
    expect(resolvePreset('last_quarter', '2026-01-01', '2026-12-31', '2026-10-05')).toEqual({
      fromDate: '2026-07-01',
      toDate: '2026-09-30',
    })
    expect(resolvePreset('last_quarter', '2025-01-01', '2026-12-31', '2026-02-15')).toEqual({
      fromDate: '2025-10-01',
      toDate: '2025-12-31',
    })
  })

  it('clamps to the selected fiscal period like the other presets', () => {
    // Broken fiscal year 2025-07-01 to 2026-06-30, seen in Q3 2026: Q2 2026 closes the period.
    expect(resolvePreset('last_quarter', '2025-07-01', '2026-06-30', '2026-08-20')).toEqual({
      fromDate: '2026-04-01',
      toDate: '2026-06-30',
    })
    // A quarter wholly before the period collapses onto its first day, as last_month does.
    expect(resolvePreset('last_quarter', '2026-01-01', '2026-12-31', '2026-02-15')).toEqual({
      fromDate: '2026-01-01',
      toDate: '2026-01-01',
    })
  })
})
