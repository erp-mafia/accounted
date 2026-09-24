import { describe, it, expect } from 'vitest'
import { orderedVisibleKpiIds } from '@/components/kpi/KPIStory'
import type { KPIPreferences } from '@/types'

describe('orderedVisibleKpiIds', () => {
  it('includes netResult when visible and respects kpiOrder', () => {
    const preferences: KPIPreferences = {
      visibleKpis: ['netResult', 'cashPosition'],
      kpiOrder: ['cashPosition', 'netResult', 'vatLiability'],
      accountOverrides: {},
      showMonthlyTable: true,
    }
    expect(orderedVisibleKpiIds(preferences)).toEqual(['cashPosition', 'netResult'])
  })

  it('omits netResult when hidden in preferences', () => {
    const preferences: KPIPreferences = {
      visibleKpis: ['cashPosition'],
      kpiOrder: ['netResult', 'cashPosition'],
      accountOverrides: {},
      showMonthlyTable: true,
    }
    expect(orderedVisibleKpiIds(preferences)).toEqual(['cashPosition'])
  })
})
