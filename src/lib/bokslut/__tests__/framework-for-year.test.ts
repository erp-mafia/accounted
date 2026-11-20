import { describe, expect, it } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import { frameworkForYear, frameworkOnDate } from '../framework-for-year'

/**
 * B1: companies.accounting_framework holds the LATEST year's framework
 * (set_fiscal_period_framework, 20261028120201). A company that elected K3
 * for its next year still reports the open current year under K2, and every
 * K3 year-end step (deferred tax, the fund, the transition, the K3
 * checklist) must read that year's own framework.
 */
describe('frameworkForYear', () => {
  it('reads the year\'s own framework, not the company\'s latest', async () => {
    const { supabase } = createTableMockSupabase({
      fiscal_period_frameworks: { data: { fiscal_period_id: 'fy-2026', framework: 'k2', source: 'company_default' } },
      companies: { data: { accounting_framework: 'k3' } },
    })
    expect(await frameworkForYear(supabase as never, 'co', 'fy-2026')).toBe('k2')
  })

  it('reads the company setting for a year without a row, as before the per-year value', async () => {
    const { supabase } = createTableMockSupabase({
      fiscal_period_frameworks: { data: null },
      companies: { data: { accounting_framework: 'k3' } },
    })
    expect(await frameworkForYear(supabase as never, 'co', 'fy-2027')).toBe('k3')
  })
})

describe('frameworkOnDate', () => {
  it('reads the framework of the year the day falls in', async () => {
    const { supabase, findCalls } = createTableMockSupabase({
      fiscal_periods: { data: { id: 'fy-2026' } },
      fiscal_period_frameworks: { data: { fiscal_period_id: 'fy-2026', framework: 'k2', source: 'company_default' } },
      companies: { data: { accounting_framework: 'k3' } },
    })
    expect(await frameworkOnDate(supabase as never, 'co', '2026-03-01')).toBe('k2')
    expect(findCalls('fiscal_periods', 'lte')).toEqual([['period_start', '2026-03-01']])
    expect(findCalls('fiscal_periods', 'gte')).toEqual([['period_end', '2026-03-01']])
  })

  it('falls back to the year running today for a day outside every year', async () => {
    const { supabase } = createTableMockSupabase({
      // No year holds the day; the company has no years at all.
      fiscal_periods: [{ data: null }, { data: [] }],
      companies: { data: { accounting_framework: 'k3' } },
    })
    expect(await frameworkOnDate(supabase as never, 'co', '2015-03-01')).toBe('k3')
  })
})
