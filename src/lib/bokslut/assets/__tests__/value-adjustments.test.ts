import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import { AssetValueAdjustmentBlockedError } from '@/lib/bookkeeping/errors'
import { computeSRUCode } from '@/lib/bookkeeping/bas-data/sru-mapping'
import { BAS_REFERENCE } from '@/lib/bookkeeping/bas-reference'
import type { Asset, AssetCategory, AssetComponent, AssetValueAdjustment } from '@/types'

/**
 * Nedskrivning (ÅRL 4:5, K3 27), mark and the depreciation start (K3 17.18):
 *   - the register's view of the write-downs (posted vouchers only) and the
 *     accounts they book on;
 *   - which assets the unit engine plans, and its charge after a write-down
 *     (what is left over the remaining life, K3 27.15 kommentar), for mark
 *     (never) and from a later start date;
 *   - the plan of a write-down or reversal from the recoverable amount, and
 *     its refusals;
 *   - a disposal clears the write-down from 12x8.
 */

vi.mock('@/lib/bookkeeping/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/engine')>()),
  createDraftEntry: vi.fn(),
  commitAssetValueAdjustment: vi.fn(),
}))

const { createDraftEntry, commitAssetValueAdjustment } = await import('@/lib/bookkeeping/engine')
const { effectiveAdjustments, netWrittenDown, writtenDownByAccount, writtenDownByKey } = await import(
  '../value-adjustments'
)
const { impairmentAccountsFor, isGoodwill } = await import('../impairment-accounts')
const { plainAssetUnit, usesUnitEngine } = await import('../asset-units')
const { computeUnitCharge } = await import('../component-depreciation')
const { allocateByWeight, postValueAdjustment, previewValueAdjustment } = await import('../value-adjustment-service')
const { buildAssetDisposalPlan } = await import('../asset-service')

const COMPANY = 'co-1'
const P2024 = { id: 'fp-2024', period_start: '2024-01-01', period_end: '2024-12-31', is_closed: false, locked_at: null }
const P2025 = { id: 'fp-2025', period_start: '2025-01-01', period_end: '2025-12-31', is_closed: false, locked_at: null }
const P2026 = { id: 'fp-2026', period_start: '2026-01-01', period_end: '2026-12-31', is_closed: false, locked_at: null }
const P2027 = { id: 'fp-2027', period_start: '2027-01-01', period_end: '2027-12-31', is_closed: false, locked_at: null }

function adjustment(overrides: Partial<AssetValueAdjustment>): AssetValueAdjustment {
  return {
    id: 'adj-1',
    asset_id: 'asset-1',
    component_id: null,
    kind: 'impairment',
    adjustment_date: '2026-12-31',
    fiscal_period_id: 'fp-2026',
    amount: '240000.00',
    recoverable_amount: '700000.00',
    reason: 'Marknadsvärdet har fallit.',
    expense_account: '7720',
    accumulated_account: '1118',
    journal_entry_id: 'je-adj-1',
    journal_entry: { status: 'posted' },
    created_at: '2027-01-10T00:00:00Z',
    ...overrides,
  }
}

function building(overrides: Partial<Asset> = {}): Asset {
  return {
    id: 'asset-1',
    user_id: 'u-1',
    company_id: COMPANY,
    name: 'Kontorshus',
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
    components: [],
    value_adjustments: [],
    notes: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    ...overrides,
  }
}

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

type Schedule = { id: string; fiscal_period_id: string; planned_depreciation: number; journal_entry_id: string | null }

function yearly(amount: number, periods: string[]): Schedule[] {
  return periods.map((period) => ({
    id: `s-${period}`,
    fiscal_period_id: `fp-${period}`,
    planned_depreciation: amount,
    journal_entry_id: `je-${period}`,
  }))
}

function context(asset: Asset, schedules: Schedule[], splits: unknown[] = []) {
  return createTableMockSupabase({
    assets: { data: asset },
    fiscal_periods: { data: [P2024, P2025, P2026, P2027] },
    depreciation_schedules: { data: schedules },
    depreciation_schedule_components: { data: splits },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('the register view of write-downs', () => {
  it('counts posted vouchers only, net of reversals, by component and by account', () => {
    const asset = building({
      value_adjustments: [
        adjustment({}),
        adjustment({ id: 'adj-2', kind: 'impairment_reversal', amount: '40000.00', adjustment_date: '2027-12-31' }),
        adjustment({ id: 'adj-3', amount: '99999.00', journal_entry: { status: 'reversed' } }),
      ],
    })
    expect(effectiveAdjustments(asset)).toHaveLength(2)
    expect(netWrittenDown(asset)).toBe(200_000)
    expect(netWrittenDown(asset, '2026-12-31')).toBe(240_000)
    expect(writtenDownByKey(asset, { before: '2027-01-01' }).get('asset-1')).toBe(240_000)
    expect(writtenDownByAccount(asset).get('1118')).toBe(200_000)
  })

  it('books on the 12x8 beside the asset\'s 12x9, else the category\'s, and 77xx by category', () => {
    expect(impairmentAccountsFor(building())).toEqual({ accumulated: '1118', expense: '7720', reversal: '7770' })
    expect(
      impairmentAccountsFor({ category: 'equipment', bas_accumulated_account: '1229' }),
    ).toEqual({ accumulated: '1228', expense: '7732', reversal: '7782' })
    // 1249 is a free account with no 1248 in BAS 2026.
    expect(impairmentAccountsFor({ category: 'vehicle', bas_accumulated_account: '1249' }).accumulated).toBe('1228')
    expect(impairmentAccountsFor({ category: 'immaterial', bas_accumulated_account: '1019' }).accumulated).toBe('1018')
    expect(impairmentAccountsFor({ category: 'land', bas_accumulated_account: '1118' })).toEqual({
      accumulated: '1118',
      expense: '7720',
      reversal: '7770',
    })
    // Förbättringsutgifter på annans fastighet: BAS 2026 has no 1128, and the
    // category's 1118 sits in another balance-sheet post (Byggnader och mark).
    expect(impairmentAccountsFor({ category: 'building', bas_accumulated_account: '1129' })).toEqual({
      accumulated: '1128',
      expense: '7720',
      reversal: '7770',
    })
    expect(isGoodwill({ bas_asset_account: '1070' })).toBe(true)
    expect(isGoodwill({ bas_asset_account: '1090' })).toBe(false)
  })

  it('keeps every write-down in the balance-sheet post of the asset\'s accumulated depreciation', () => {
    const categories: AssetCategory[] = [
      'immaterial', 'building', 'land', 'land_improvement', 'machinery', 'equipment', 'vehicle', 'computer', 'other_tangible',
    ]
    const depreciationAccounts = BAS_REFERENCE.map((account) => account.account_number).filter(
      (number) => number >= '1000' && number <= '1299' && number.endsWith('9'),
    )
    for (const own of depreciationAccounts) {
      for (const category of categories) {
        const { accumulated } = impairmentAccountsFor({ category, bas_accumulated_account: own })
        expect([own, category, computeSRUCode(accumulated)]).toEqual([own, category, computeSRUCode(own)])
      }
    }
  })
})

describe('the unit engine for mark, a later start and a written-down asset', () => {
  const complete = () => true

  it('plans only the assets the asset-level path cannot', () => {
    expect(usesUnitEngine(building())).toBe(false)
    expect(usesUnitEngine(building({ category: 'land', useful_life_months: 0 }))).toBe(true)
    expect(usesUnitEngine(building({ depreciation_start_date: '2024-04-01' }))).toBe(true)
    expect(usesUnitEngine(building({ depreciation_start_date: '2024-01-01' }))).toBe(false)
    expect(usesUnitEngine(building({ value_adjustments: [adjustment({})] }))).toBe(true)
    expect(usesUnitEngine(building({ value_adjustments: [adjustment({ journal_entry: { status: 'reversed' } })] }))).toBe(false)
  })

  it('never depreciates mark', () => {
    const land = building({ category: 'land', useful_life_months: 0, bas_asset_account: '1130', bas_accumulated_account: '1118' })
    const unit = plainAssetUnit(land, { posted: 0, writtenDown: 0, isComplete: complete }, '2026-01-01')
    expect(unit.usefulLifeMonths).toBeNull()
    expect(computeUnitCharge(unit, P2026).amount).toBe(0)
  })

  it('starts the plan on the start date and runs the full life from it', () => {
    // 60 000 over 60 months from 1 July: 184 of 2024's 366 days.
    const asset = building({ acquisition_cost: 60_000, useful_life_months: 60, depreciation_start_date: '2024-07-01' })
    const unit = plainAssetUnit(asset, { posted: 0, writtenDown: 0, isComplete: complete }, '2024-01-01')
    expect(computeUnitCharge(unit, P2024).amount).toBe(6_033)
  })

  it('spreads what is left after a write-down over the remaining life', () => {
    // 1 000 000 over 50 years, 60 000 posted 2024-2026, 240 000 written down
    // at 2026-12-31: 700 000 over the 564 months left.
    const asset = building({ value_adjustments: [adjustment({})] })
    const unit = plainAssetUnit(
      asset,
      { posted: 60_000, writtenDown: 240_000, isComplete: complete },
      '2027-01-01',
    )
    expect(computeUnitCharge(unit, P2027).amount).toBe(14_894)
  })
})

describe('allocateByWeight', () => {
  it('spreads by weight in öre, within each cap, summing exactly', () => {
    const shares = allocateByWeight(100_000, [
      { key: 'tak', weight: 176_000, cap: 176_000 },
      { key: 'stomme', weight: 776_000, cap: 776_000 },
    ])
    expect(shares.get('tak')).toBe(18_487.39)
    expect(shares.get('stomme')).toBe(81_512.61)
  })
})

describe('previewValueAdjustment', () => {
  const input = {
    kind: 'impairment' as const,
    fiscal_period_id: 'fp-2026',
    recoverable_amount: 700_000,
    reason: 'Marknadsvärdet har fallit.',
  }

  it('writes the carrying amount down to the recoverable amount on the balansdag', async () => {
    const { supabase } = context(building(), yearly(20_000, ['2024', '2025', '2026']))
    const preview = await previewValueAdjustment(supabase as never, COMPANY, 'asset-1', input)
    expect(preview).toMatchObject({
      adjustmentDate: '2026-12-31',
      carryingAmountBefore: 940_000,
      amount: 240_000,
      carryingAmountAfter: 700_000,
      expenseAccount: '7720',
      accumulatedAccount: '1118',
    })
    expect(preview.lines).toEqual([
      expect.objectContaining({ account_number: '7720', debit_amount: 240_000, credit_amount: 0 }),
      expect.objectContaining({ account_number: '1118', debit_amount: 0, credit_amount: 240_000 }),
    ])
    expect(preview.components).toBeUndefined()
  })

  it('wants the year\'s depreciation posted first', async () => {
    const { supabase } = context(building(), yearly(20_000, ['2024', '2025']))
    await expect(previewValueAdjustment(supabase as never, COMPANY, 'asset-1', input)).rejects.toMatchObject({
      reason: 'year_not_depreciated',
    })
  })

  it('refuses when an earlier year is missing from the register', async () => {
    const { supabase } = context(building(), yearly(20_000, ['2025', '2026']))
    await expect(previewValueAdjustment(supabase as never, COMPANY, 'asset-1', input)).rejects.toMatchObject({
      reason: 'history_incomplete',
    })
  })

  it('refuses when the recoverable amount is not lower', async () => {
    const { supabase } = context(building(), yearly(20_000, ['2024', '2025', '2026']))
    await expect(
      previewValueAdjustment(supabase as never, COMPANY, 'asset-1', { ...input, recoverable_amount: 950_000 }),
    ).rejects.toBeInstanceOf(AssetValueAdjustmentBlockedError)
  })

  it('reverses at most to the carrying amount without the write-down (K3 27.15)', async () => {
    const asset = building({ value_adjustments: [adjustment({})] })
    const schedules = [
      ...yearly(20_000, ['2024', '2025', '2026']),
      { id: 's-2027', fiscal_period_id: 'fp-2027', planned_depreciation: 14_894, journal_entry_id: 'je-2027' },
    ]
    const { supabase } = context(asset, schedules)
    const preview = await previewValueAdjustment(supabase as never, COMPANY, 'asset-1', {
      kind: 'impairment_reversal',
      fiscal_period_id: 'fp-2027',
      recoverable_amount: 1_000_000,
      reason: 'Marknaden har återhämtat sig.',
    })
    // Without the write-down: 1 000 000 - 4 x 20 000 = 920 000; carried at
    // 1 000 000 - 74 894 - 240 000 = 685 106.
    expect(preview.amount).toBe(234_894)
    expect(preview.lines).toEqual([
      expect.objectContaining({ account_number: '1118', debit_amount: 234_894 }),
      expect.objectContaining({ account_number: '7770', credit_amount: 234_894 }),
    ])
  })

  it('never reverses a goodwill write-down', async () => {
    const goodwill = building({
      category: 'immaterial',
      bas_asset_account: '1070',
      bas_accumulated_account: '1079',
      bas_expense_account: '7817',
      value_adjustments: [adjustment({ accumulated_account: '1078' })],
    })
    const { supabase } = context(goodwill, [])
    await expect(
      previewValueAdjustment(supabase as never, COMPANY, 'asset-1', {
        kind: 'impairment_reversal',
        fiscal_period_id: 'fp-2027',
        recoverable_amount: 1_000_000,
        reason: 'x',
      }),
    ).rejects.toMatchObject({ reason: 'goodwill_reversal' })
  })

  it('spreads a component asset\'s write-down by carrying amount (K3 27.13 b)', async () => {
    const asset = building({
      components: [
        component({}),
        component({ id: 'stomme', name: 'Stomme', cost: '800000.00', useful_life_months: 1200, sort_order: 1 }),
      ],
    })
    const schedules = yearly(16_000, ['2024', '2025', '2026'])
    const splits = schedules.flatMap((s) => [
      { schedule_id: s.id, component_id: 'tak', amount: 8000 },
      { schedule_id: s.id, component_id: 'stomme', amount: 8000 },
    ])
    const { supabase } = context(asset, schedules, splits)
    const preview = await previewValueAdjustment(supabase as never, COMPANY, 'asset-1', {
      ...input,
      recoverable_amount: 852_000,
    })
    expect(preview.amount).toBe(100_000)
    expect(preview.components).toEqual([
      { component_id: 'tak', name: 'Tak', amount: 18_487.39 },
      { component_id: 'stomme', name: 'Stomme', amount: 81_512.61 },
    ])
  })
})

describe('postValueAdjustment', () => {
  it('drafts a system voucher on the balansdag and commits it with the register rows', async () => {
    const { supabase } = context(building(), yearly(20_000, ['2024', '2025', '2026']))
    vi.mocked(createDraftEntry).mockResolvedValue({ id: 'draft-1', fiscal_period_id: 'fp-2026' } as never)
    vi.mocked(commitAssetValueAdjustment).mockResolvedValue({ entry: { id: 'draft-1' } } as never)
    await postValueAdjustment(supabase as never, COMPANY, 'user-1', 'asset-1', {
      kind: 'impairment',
      fiscal_period_id: 'fp-2026',
      recoverable_amount: 700_000,
      reason: '  Marknadsvärdet har fallit.  ',
    })
    expect(createDraftEntry).toHaveBeenCalledWith(
      supabase,
      COMPANY,
      'user-1',
      expect.objectContaining({ entry_date: '2026-12-31', source_type: 'system', fiscal_period_id: 'fp-2026' }),
    )
    expect(commitAssetValueAdjustment).toHaveBeenCalledWith(
      supabase,
      COMPANY,
      'user-1',
      expect.objectContaining({ id: 'draft-1' }),
      {
        asset_id: 'asset-1',
        kind: 'impairment',
        adjustment_date: '2026-12-31',
        amount: 240_000,
        recoverable_amount: 700_000,
        reason: 'Marknadsvärdet har fallit.',
        expense_account: '7720',
        accumulated_account: '1118',
      },
    )
  })
})

describe('postValueAdjustment on förbättringsutgifter på annans fastighet', () => {
  it('adds 1128 to the chart and books the write-down there, in the asset\'s own post', async () => {
    const improvement = building({ name: 'Ombyggnad hyrd lokal', bas_asset_account: '1120', bas_accumulated_account: '1129' })
    const { supabase, payloads } = context(improvement, yearly(20_000, ['2024', '2025', '2026']))
    vi.mocked(createDraftEntry).mockResolvedValue({ id: 'draft-1', fiscal_period_id: 'fp-2026' } as never)
    vi.mocked(commitAssetValueAdjustment).mockResolvedValue({ entry: { id: 'draft-1' } } as never)
    await postValueAdjustment(supabase as never, COMPANY, 'user-1', 'asset-1', {
      kind: 'impairment',
      fiscal_period_id: 'fp-2026',
      recoverable_amount: 700_000,
      reason: 'Hyresavtalet sägs upp i förtid.',
    })
    expect(payloads('chart_of_accounts', 'upsert')).toEqual([
      expect.objectContaining({ account_number: '1128', sru_code: '7216', normal_balance: 'credit' }),
    ])
    const draftInput = vi.mocked(createDraftEntry).mock.calls[0][3]
    expect(draftInput.lines).toContainEqual(
      expect.objectContaining({ account_number: '1128', debit_amount: 0, credit_amount: 240_000 }),
    )
    expect(vi.mocked(commitAssetValueAdjustment).mock.calls[0][4]).toMatchObject({ accumulated_account: '1128' })
  })
})

describe('disposal of a written-down asset', () => {
  it('clears the write-down from 12x8 and takes it out of the book value', () => {
    const asset = building({ value_adjustments: [adjustment({})] })
    const plan = buildAssetDisposalPlan({
      proceedsAccount: '1930',
      asset,
      input: {
        disposal_type: 'scrap',
        disposed_at: '2027-12-31',
        disposed_proceeds: 0,
        fiscal_period_id: 'fp-2027',
        jamkning_original_input_vat: 0,
        jamkning_original_deduction_percent: 0,
      },
      fiscalPeriod: P2027,
      periods: [P2024, P2025, P2026, P2027],
      schedules: yearly(20_000, ['2024', '2025', '2026']),
    })
    expect(plan.writtenDown).toBe(240_000)
    // The year's charge after the write-down: 700 000 over 564 months.
    expect(plan.currentDepreciation).toBe(14_894)
    expect(plan.lines).toContainEqual(expect.objectContaining({ account_number: '1118', debit_amount: 240_000 }))
    // Book value 1 000 000 - 74 894 - 240 000, all lost on a scrap.
    expect(plan.gainOrLoss).toBe(-685_106)
  })

  it('refuses a disposal dated before a posted write-down', () => {
    const asset = building({ value_adjustments: [adjustment({})] })
    expect(() =>
      buildAssetDisposalPlan({
        proceedsAccount: '1930',
        asset,
        input: { disposal_type: 'scrap', disposed_at: '2026-06-30', disposed_proceeds: 0, fiscal_period_id: 'fp-2026' },
        fiscalPeriod: P2026,
        periods: [P2024, P2025, P2026],
        schedules: yearly(20_000, ['2024', '2025']),
      }),
    ).toThrow(expect.objectContaining({ reason: 'later_value_adjustment' }))
  })
})

describe('writeDownMovement', () => {
  it('gives the year\'s write-downs, reversals and disposal for the asset note (ÅRL 5:8)', async () => {
    const { writeDownMovement } = await import('../value-adjustments')
    const asset = building({
      value_adjustments: [
        adjustment({}),
        adjustment({ id: 'adj-2', kind: 'impairment_reversal', amount: '40000.00', adjustment_date: '2027-12-31' }),
        adjustment({ id: 'adj-3', amount: '10000.00', adjustment_date: '2027-12-31' }),
      ],
    })
    expect(writeDownMovement(asset, '2027-01-01', '2027-12-31')).toEqual({
      opening: 240_000,
      writtenDown: 10_000,
      reversed: 40_000,
      disposed: 0,
      closing: 210_000,
    })
    expect(writeDownMovement({ ...asset, disposed_at: '2028-03-31' }, '2028-01-01', '2028-12-31')).toEqual({
      opening: 210_000,
      writtenDown: 0,
      reversed: 0,
      disposed: 210_000,
      closing: 0,
    })
  })
})

describe('registerWriteDownsByAccount', () => {
  it('sums the register\'s write-downs per accumulated account, and skips an asset gone before the year', async () => {
    const { registerWriteDownsByAccount } = await import('../value-adjustments')
    const row = (id: string, account: string, kind: 'impairment' | 'reversal', date: string, amount: number) =>
      ({ id, component_id: null, kind, adjustment_date: date, amount, accumulated_account: account, journal_entry: { status: 'posted' } })
    const byAccount = registerWriteDownsByAccount(
      [
        { id: 'a', disposed_at: null, value_adjustments: [row('1', '1218', 'impairment', '2024-06-30', 10_000), row('2', '1218', 'reversal', '2025-06-30', 4_000)] },
        { id: 'b', disposed_at: null, value_adjustments: [row('3', '1218', 'impairment', '2025-03-31', 6_000), row('4', '1118', 'impairment', '2025-03-31', 1_000)] },
        { id: 'c', disposed_at: '2024-12-31', value_adjustments: [row('5', '1218', 'impairment', '2023-06-30', 9_000)] },
      ] as never,
      '2025-01-01',
      '2025-12-31',
    )
    expect(byAccount.get('1218')).toEqual({ opening: 10_000, writtenDown: 6_000, reversed: 4_000, disposed: 0, closing: 12_000 })
    expect(byAccount.get('1118')).toEqual({ opening: 0, writtenDown: 1_000, reversed: 0, disposed: 0, closing: 1_000 })
  })
})
