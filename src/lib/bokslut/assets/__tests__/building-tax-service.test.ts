import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import type { Asset } from '@/types'

vi.mock('../asset-chart-accounts', () => ({
  chartAwareDefaultAccounts: vi.fn(async (_s: unknown, _c: unknown, _cat: unknown, defaults: unknown) => defaults),
  ensureAssetAccountsInChart: vi.fn(async () => undefined),
  unusableAssetAccounts: vi.fn(async () => []),
}))

const { AssetTaxPlanLockedError, setAssetTaxPlan } = await import('../building-tax-service')

/**
 * F6: INK2 is computed afresh, never stored, so a tax plan stated or changed
 * today would move INK2S 4.9 and the taxable result of a year already
 * declared. A plan reaches only the years still open when it is stated
 * (tax_plan_applies_from, set by the database); once a year it reached is
 * closed or locked, it cannot be changed.
 */

function building(overrides: Partial<Asset> = {}): Asset {
  return {
    id: 'b-1',
    company_id: 'co',
    name: 'Kontorshus',
    category: 'building',
    acquisition_date: '2020-01-01',
    acquisition_cost: 1_000_000,
    disposed_at: null,
    components: [],
    value_adjustments: [],
    k3_components: null,
    tax_depreciation_rate: null,
    tax_depreciation_from: null,
    tax_primary_allowance: false,
    tax_plan_applies_from: null,
    ...overrides,
  } as Asset
}

const CLOSED_2025 = [
  { period_end: '2025-12-31', is_closed: true, locked_at: null, closing_entry_id: null },
  { period_end: '2026-12-31', is_closed: false, locked_at: null, closing_entry_id: null },
]

const PLAN = { tax_depreciation_rate: 2, tax_depreciation_from: null, tax_primary_allowance: false }

function client(asset: Asset, assetsAfter: unknown[] = []) {
  return createTableMockSupabase({
    assets: [{ data: asset }, ...assetsAfter.map((row) => (row instanceof Error ? { error: { message: row.message } } : { data: row }))],
    fiscal_periods: { data: CLOSED_2025 },
    company_settings: { data: { bookkeeping_locked_through: null } },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('setAssetTaxPlan', () => {
  it('states a plan from the first year still open, and says so on a dry run', async () => {
    const { supabase, findCall } = client(building())
    const preview = await setAssetTaxPlan(supabase as never, 'co', 'b-1', PLAN, { dryRun: true })
    expect(preview).toMatchObject({ tax_depreciation_rate: 2, tax_plan_applies_from: '2026-01-01' })
    expect(findCall('assets', 'update')).toBeUndefined()
  })

  it('changes a plan whose years are all still open', async () => {
    const asset = building({ tax_depreciation_rate: 2, tax_plan_applies_from: '2026-01-01' })
    const { supabase, findCall } = client(asset, [null, asset])
    await setAssetTaxPlan(supabase as never, 'co', 'b-1', { ...PLAN, tax_depreciation_rate: 3 })
    expect(findCall('assets', 'update')).toEqual([{ tax_depreciation_rate: 3, tax_depreciation_from: null, tax_primary_allowance: false }])
  })

  it('refuses to change or clear a plan a closed year was declared with', async () => {
    const asset = building({ tax_depreciation_rate: 2, tax_plan_applies_from: '2025-01-01' })
    for (const input of [{ ...PLAN, tax_depreciation_rate: 3 }, { ...PLAN, tax_depreciation_rate: null }]) {
      const { supabase, findCall } = client(asset)
      await expect(setAssetTaxPlan(supabase as never, 'co', 'b-1', input)).rejects.toBeInstanceOf(AssetTaxPlanLockedError)
      expect(findCall('assets', 'update')).toBeUndefined()
    }
  })

  it('writes nothing when the plan already stands', async () => {
    const asset = building({ tax_depreciation_rate: '2.000', tax_plan_applies_from: '2025-01-01' })
    const { supabase, findCall, tables } = client(asset)
    await expect(setAssetTaxPlan(supabase as never, 'co', 'b-1', PLAN)).resolves.toBe(asset)
    expect(findCall('assets', 'update')).toBeUndefined()
    expect(tables()).not.toContain('fiscal_periods')
  })

  it('reads the database\'s refusal as the same error', async () => {
    const asset = building({ tax_depreciation_rate: 2, tax_plan_applies_from: '2026-01-01' })
    const { supabase } = client(asset, [new Error('TAX_PLAN_USED_BY_CLOSED_YEAR')])
    await expect(
      setAssetTaxPlan(supabase as never, 'co', 'b-1', { ...PLAN, tax_depreciation_rate: 3 }),
    ).rejects.toMatchObject({ code: 'TAX_PLAN_USED_BY_CLOSED_YEAR' })
  })
})
