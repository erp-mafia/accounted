/**
 * Depreciation reads past PostgREST's 1,000-row cap (max-rows). A company
 * with many assets and years has more depreciation_schedules rows than that:
 * the proposal then undercounted the accumulated depreciation, and the
 * "already posted" lock missed assets whose rows came later.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Asset } from '@/types'
import { createPagedMockSupabase, manyRows } from '@/tests/helpers'

const listAssets = vi.fn()
vi.mock('../asset-service', () => ({
  listAssets: (...args: unknown[]) => listAssets(...args),
}))

const { proposeAnnualPostings } = await import('../depreciation-engine')
const { loadPostedDepreciationAssetIds } = await import('../asset-api')

const asset = {
  id: 'a-1',
  company_id: 'co',
  name: 'Maskin',
  category: 'equipment',
  acquisition_date: '2020-01-01',
  acquisition_cost: 100000,
  salvage_value: 0,
  useful_life_months: 60,
  depreciation_method: 'linear',
  bas_asset_account: '1220',
  bas_accumulated_account: '1229',
  bas_expense_account: '7832',
  restvarde_target: null,
  disposed_at: null,
  k3_components: null,
} as unknown as Asset

describe('depreciation past 1,000 schedule rows', () => {
  it('proposeAnnualPostings sums every prior posted schedule into the restvärde', async () => {
    listAssets.mockResolvedValue([asset])
    const { supabase } = createPagedMockSupabase({
      fiscal_periods: [{ id: 'p-2022', name: '2022', period_start: '2022-01-01', period_end: '2022-12-31' }],
      depreciation_schedules: manyRows(1001, (i) => ({
        id: `s-${i}`,
        asset_id: 'a-1',
        planned_depreciation: 10,
        journal_entry_id: `je-${i}`,
        fiscal_period_id: 'p-old',
      })),
    })

    const proposal = await proposeAnnualPostings(supabase as never, 'co', 'p-2022')

    // 100 000 cost, 20 000 this year, 1 001 x 10 posted before.
    expect(proposal.items[0].netBookValueAfter).toBe(100000 - 20000 - 10010)
  })

  it('loadPostedDepreciationAssetIds finds an asset whose posted rows come after the first 1,000', async () => {
    const { supabase } = createPagedMockSupabase({
      depreciation_schedules: [
        ...manyRows(1000, () => ({ asset_id: 'a-1' })),
        { asset_id: 'a-2' },
      ],
    })

    const posted = await loadPostedDepreciationAssetIds(supabase as never, 'co', ['a-1', 'a-2'])

    expect(posted.has('a-2')).toBe(true)
  })
})
