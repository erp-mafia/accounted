import { describe, it, expect } from 'vitest'
import {
  dimensionScopedPreferences,
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

describe('dimensionScopedPreferences', () => {
  it('keeps only the P&L figures a dimension filter narrows', () => {
    // kpi-report.ts filters the income statement, the months and the expense
    // accounts; cash, VAT, receivables and payment days stay company-wide.
    expect(KPI_DEFINITIONS.filter((d) => d.followsDimensionFilter).map((d) => d.id).sort()).toEqual(
      ['expenseRatio', 'grossMargin', 'netResult'],
    )

    const prefs = {
      visibleKpis: ['netResult', 'cashPosition', 'outstandingReceivables', 'vatLiability', 'grossMargin', 'avgPaymentDays'],
      kpiOrder: ['vatLiability', 'grossMargin', 'netResult', 'cashPosition', 'outstandingReceivables', 'avgPaymentDays', 'expenseRatio'],
      accountOverrides: { cashPosition: ['1930'] },
      showMonthlyTable: true,
    }
    const scoped = dimensionScopedPreferences(prefs)

    expect(scoped.visibleKpis).toEqual(['netResult', 'grossMargin'])
    // Only what is shown changes: order, overrides and the table flag stay the user's.
    expect(scoped.kpiOrder).toBe(prefs.kpiOrder)
    expect(scoped.accountOverrides).toBe(prefs.accountOverrides)
    expect(scoped.showMonthlyTable).toBe(true)
    expect(prefs.visibleKpis).toHaveLength(6) // the stored layout is not mutated
  })
})
