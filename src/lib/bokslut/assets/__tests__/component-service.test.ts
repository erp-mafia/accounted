import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import type { Asset, AssetComponent } from '@/types'

vi.mock('@/lib/bookkeeping/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/engine')>()),
  createDraftEntry: vi.fn(),
  commitAssetComponentReplacement: vi.fn(),
}))

const { createDraftEntry, commitAssetComponentReplacement } = await import('@/lib/bookkeeping/engine')
const {
  addAssetComponent,
  previewComponentReplacement,
  replaceAssetComponent,
  updateAssetComponent,
  AssetComponentReplacementBlockedError,
} = await import('../component-service')
const { AssetComponentsInvalidError } = await import('../asset-service')

const COMPANY = 'co-1'
const P2024 = { id: 'fp-2024', period_start: '2024-01-01', period_end: '2024-12-31' }
const P2025 = { id: 'fp-2025', period_start: '2025-01-01', period_end: '2025-12-31' }
const P2026 = { id: 'fp-2026', period_start: '2026-01-01', period_end: '2026-12-31' }

function component(overrides: Partial<AssetComponent>): AssetComponent {
  return {
    id: 'tak',
    user_id: 'u-1',
    company_id: COMPANY,
    asset_id: 'asset-1',
    name: 'Tak',
    cost: '200000.00',
    useful_life_months: 300,
    salvage_value: '0.00',
    acquisition_date: '2024-01-01',
    depreciation_start_date: null,
    opening_accumulated_depreciation: '0.00',
    opening_depreciation_date: null,
    replaces_component_id: null,
    derecognised_at: null,
    derecognition_journal_entry_id: null,
    derecognition_depreciation: '0.00',
    sort_order: 0,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    ...overrides,
  }
}

function building(components: AssetComponent[] = [
  component({}),
  component({ id: 'stomme', name: 'Stomme', cost: '800000.00', useful_life_months: 1200, sort_order: 1 }),
]): Asset {
  return {
    id: 'asset-1',
    user_id: 'u-1',
    company_id: COMPANY,
    name: 'Fastighet',
    category: 'building',
    acquisition_date: '2024-01-01',
    acquisition_cost: 1_000_000,
    salvage_value: 0,
    useful_life_months: 600,
    depreciation_method: 'linear',
    bas_asset_account: '1110',
    bas_accumulated_account: '1119',
    bas_expense_account: '7821',
    restvarde_target: null,
    disposed_at: null,
    disposed_proceeds: null,
    disposed_proceeds_vat: 0,
    disposed_vat_treatment: null,
    jamkning_amount: 0,
    jamkning_remaining_months: null,
    jamkning_total_months: null,
    jamkning_original_input_vat: null,
    k3_components: null,
    components,
    notes: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  }
}

function context(opts: { asset?: Asset; schedules?: Array<{ id: string; fiscal_period_id: string; journal_entry_id: string | null }> } = {}) {
  const schedules = opts.schedules ?? [
    { id: 's-2024', fiscal_period_id: 'fp-2024', journal_entry_id: 'je-2024' },
    { id: 's-2025', fiscal_period_id: 'fp-2025', journal_entry_id: 'je-2025' },
  ]
  return createTableMockSupabase({
    assets: { data: opts.asset ?? building() },
    fiscal_periods: { data: [P2024, P2025, P2026] },
    depreciation_schedules: { data: schedules },
    depreciation_schedule_components: {
      data: schedules
        .filter((s) => s.journal_entry_id)
        .flatMap((s) => [
          { schedule_id: s.id, component_id: 'tak', amount: 8000 },
          { schedule_id: s.id, component_id: 'stomme', amount: 8000 },
        ]),
    },
    asset_components: { data: null },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('previewComponentReplacement', () => {
  it('charges the component to the replacement date, clears it and books the carrying amount as a loss', async () => {
    const { supabase } = context()
    const { plan } = await previewComponentReplacement(supabase as never, COMPANY, 'asset-1', 'tak', {
      replaced_at: '2026-06-30',
      fiscal_period_id: 'fp-2026',
      new_component: { name: 'Nytt tak', cost: 250_000, useful_life_months: 360 },
    })
    // 181 of 365 days of the 8 000 kr year.
    expect(plan.depreciationToDate).toBe(3_967)
    expect(plan.accumulatedCleared).toBe(19_967)
    expect(plan.carryingAmount).toBe(180_033)
    expect(plan.lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount])).toEqual([
      ['7821', 3_967, 0],
      ['1119', 0, 3_967],
      ['1119', 19_967, 0],
      ['1110', 0, 200_000],
      ['7972', 180_033, 0],
    ])
    const debit = plan.lines.reduce((s, l) => s + l.debit_amount, 0)
    const credit = plan.lines.reduce((s, l) => s + l.credit_amount, 0)
    expect(debit).toBe(credit)
  })

  it('refuses while an earlier year is still to be depreciated', async () => {
    const { supabase } = context({ schedules: [{ id: 's-2024', fiscal_period_id: 'fp-2024', journal_entry_id: 'je-2024' }] })
    await expect(
      previewComponentReplacement(supabase as never, COMPANY, 'asset-1', 'tak', { replaced_at: '2026-06-30', fiscal_period_id: 'fp-2026' }),
    ).rejects.toMatchObject({ reason: 'earlier_year_unposted' })
  })

  it('refuses a mid-year replacement once the year is depreciated', async () => {
    const { supabase } = context({
      schedules: [
        { id: 's-2024', fiscal_period_id: 'fp-2024', journal_entry_id: 'je-2024' },
        { id: 's-2025', fiscal_period_id: 'fp-2025', journal_entry_id: 'je-2025' },
        { id: 's-2026', fiscal_period_id: 'fp-2026', journal_entry_id: 'je-2026' },
      ],
    })
    await expect(
      previewComponentReplacement(supabase as never, COMPANY, 'asset-1', 'tak', { replaced_at: '2026-06-30', fiscal_period_id: 'fp-2026' }),
    ).rejects.toBeInstanceOf(AssetComponentReplacementBlockedError)
  })

  it('refuses taking off the last component without a replacement', async () => {
    const { supabase } = context({ asset: building([component({})]) })
    await expect(
      previewComponentReplacement(supabase as never, COMPANY, 'asset-1', 'tak', { replaced_at: '2026-06-30', fiscal_period_id: 'fp-2026' }),
    ).rejects.toMatchObject({ reason: 'last_component' })
  })
})

describe('replaceAssetComponent', () => {
  it('drafts the voucher as a system entry and commits it with the register change in one RPC', async () => {
    const { supabase } = context()
    vi.mocked(createDraftEntry).mockImplementation(async (_s, _c, _u, input) => ({ id: 'je-new', ...input }) as never)
    vi.mocked(commitAssetComponentReplacement).mockResolvedValue({ entry: { id: 'je-new' }, newComponentId: 'comp-new' } as never)
    const result = await replaceAssetComponent(supabase as never, COMPANY, 'u-1', 'asset-1', 'tak', {
      replaced_at: '2026-06-30',
      fiscal_period_id: 'fp-2026',
      new_component: { name: ' Nytt tak ', cost: 250_000, useful_life_months: 360 },
    })
    expect(vi.mocked(createDraftEntry).mock.calls[0][3]).toMatchObject({
      fiscal_period_id: 'fp-2026',
      entry_date: '2026-06-30',
      source_type: 'system',
    })
    expect(vi.mocked(commitAssetComponentReplacement).mock.calls[0][4]).toEqual({
      asset_id: 'asset-1',
      component_id: 'tak',
      derecognised_at: '2026-06-30',
      depreciation_to_date: 3_967,
      accumulated_cleared: 19_967,
      new_component: {
        name: 'Nytt tak',
        cost: 250_000,
        useful_life_months: 360,
        salvage_value: 0,
        acquisition_date: null,
        depreciation_start_date: null,
      },
    })
    expect(result.newComponentId).toBe('comp-new')
  })
})

describe('the component register', () => {
  it('adds a tillkommande component after the last one, and refuses on an asset without components', async () => {
    const { supabase, payloads } = context()
    await addAssetComponent(supabase as never, COMPANY, 'u-1', 'asset-1', { name: 'Hiss', cost: 50_000, useful_life_months: 300 })
    expect(payloads('asset_components', 'insert')[0]).toMatchObject({
      name: 'Hiss',
      cost: 50_000,
      sort_order: 2,
      acquisition_date: '2024-01-01',
      user_id: 'u-1',
    })
    const { supabase: plain } = context({ asset: building([]) })
    await expect(
      addAssetComponent(plain as never, COMPANY, 'u-1', 'asset-1', { name: 'Hiss', cost: 50_000, useful_life_months: 300 }),
    ).rejects.toBeInstanceOf(AssetComponentsInvalidError)
  })

  it('writes only the fields that changed, so a re-estimate passes a posted basis', async () => {
    const { supabase, payloads } = context()
    await updateAssetComponent(supabase as never, COMPANY, 'asset-1', 'tak', { useful_life_months: 240 })
    expect(payloads('asset_components', 'update')).toEqual([{ useful_life_months: 240 }])
  })
})
