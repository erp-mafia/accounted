import { describe, it, expect } from 'vitest'
import {
  getDefaultPreferences,
  mergeWithDefaults,
  KPI_DEFINITIONS,
} from '@/lib/reports/kpi-definitions'

describe('KPI preferences defaults', () => {
  it('shows the monthly table by default', () => {
    expect(getDefaultPreferences().showMonthlyTable).toBe(true)
  })

  it('does not model the monthly table as a KPI definition', () => {
    // A definition id would be hidden by every stored kpiOrder array (#2196).
    expect(KPI_DEFINITIONS.some((d) => d.id === 'showMonthlyTable')).toBe(false)
    expect(getDefaultPreferences().kpiOrder).not.toContain('showMonthlyTable')
  })

  it('fills showMonthlyTable from the defaults for a row stored before the flag existed', () => {
    const merged = mergeWithDefaults({
      visibleKpis: ['netResult'],
      kpiOrder: ['netResult'],
      accountOverrides: {},
    })
    expect(merged.showMonthlyTable).toBe(true)
  })

  it('keeps a stored false', () => {
    expect(mergeWithDefaults({ showMonthlyTable: false }).showMonthlyTable).toBe(false)
  })
})
