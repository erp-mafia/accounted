import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Asset, TrialBalanceRow } from '@/types'

vi.mock('@/lib/bokslut/assets/asset-service', () => ({
  listAssets: vi.fn(),
}))

vi.mock('@/lib/bokslut/assets/depreciation-engine', () => ({
  proposeAnnualPostings: vi.fn(),
}))

vi.mock('@/lib/reports/trial-balance', () => ({
  generateTrialBalance: vi.fn(),
}))

import { listAssets } from '@/lib/bokslut/assets/asset-service'
import { proposeAnnualPostings } from '@/lib/bokslut/assets/depreciation-engine'
import { generateTrialBalance } from '@/lib/reports/trial-balance'
import { calculateOveravskrivningar } from '../reserves/overavskrivningar-calculator'

const PERIOD = {
  id: 'period-2026',
  period_start: '2026-01-01',
  period_end: '2026-12-31',
}

function makeAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: 'asset-1',
    user_id: 'user-1',
    company_id: 'company-1',
    name: 'Production equipment',
    category: 'equipment',
    acquisition_date: '2026-01-15',
    acquisition_cost: 100_000,
    salvage_value: 0,
    useful_life_months: 60,
    depreciation_method: 'linear',
    bas_asset_account: '1220',
    bas_accumulated_account: '1229',
    bas_expense_account: '7832',
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
    notes: null,
    created_at: '2026-01-15T00:00:00Z',
    updated_at: '2026-01-15T00:00:00Z',
    ...overrides,
  }
}

function row(
  accountNumber: string,
  values: Partial<TrialBalanceRow> = {},
): TrialBalanceRow {
  return {
    account_number: accountNumber,
    account_name: accountNumber,
    account_class: Number(accountNumber[0]),
    opening_debit: 0,
    opening_credit: 0,
    period_debit: 0,
    period_credit: 0,
    closing_debit: 0,
    closing_credit: 0,
    ...values,
  }
}

function makeSupabase(periods = [PERIOD]) {
  const builder: Record<string, unknown> = {}
  builder.select = vi.fn(() => builder)
  builder.eq = vi.fn(() => builder)
  builder.lte = vi.fn(() => builder)
  builder.order = vi.fn(() => builder)
  builder.limit = vi.fn(async () => ({ data: periods, error: null }))
  return {
    from: vi.fn(() => builder),
  }
}

function mockTrialBalance(rows: TrialBalanceRow[]) {
  vi.mocked(generateTrialBalance).mockResolvedValue({
    rows,
    totalDebit: 0,
    totalCredit: 0,
    isBalanced: true,
  })
}

function mockPostedDepreciation(asset: Asset) {
  vi.mocked(proposeAnnualPostings).mockResolvedValue({
    fiscalPeriod: { ...PERIOD, name: '2026' },
    items: [
      {
        asset,
        amount: 20_000,
        netBookValueAfter: 80_000,
        proRated: false,
        existingScheduleId: 'schedule-1',
        existingJournalEntryId: 'entry-1',
      },
    ],
    totalAmount: 20_000,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('calculateOveravskrivningar', () => {
  it('proposes the 8853/2153 bridge after planned depreciation is posted', async () => {
    const asset = makeAsset()
    vi.mocked(listAssets).mockResolvedValue([asset])
    mockPostedDepreciation(asset)
    mockTrialBalance([
      row('1220', { period_debit: 100_000, closing_debit: 100_000 }),
      row('1229', { period_credit: 20_000, closing_credit: 20_000 }),
    ])

    const result = await calculateOveravskrivningar({
      supabase: makeSupabase() as never,
      companyId: 'company-1',
      fiscalPeriod: PERIOD,
      entityType: 'aktiebolag',
    })

    // 30-rule residual 70,000 beats 20-rule residual 80,000. Book value is
    // 80,000, so 10,000 is bridged through the untaxed reserve.
    expect(result.status).toBe('ready')
    expect(result.selectedRule).toBe('30-regeln')
    expect(result.targetReserve).toBe(10_000)
    expect(result.proposal?.signedAmount).toBe(10_000)
    expect(result.proposal?.lines.map((line) => line.account_number)).toEqual([
      '8853',
      '2153',
    ])
  })

  it('requires a release when the existing reserve exceeds the lawful target', async () => {
    const asset = makeAsset({
      acquisition_date: '2020-01-01',
      acquisition_cost: 100_000,
    })
    vi.mocked(listAssets).mockResolvedValue([asset])
    mockPostedDepreciation(asset)
    mockTrialBalance([
      row('1220', { opening_debit: 100_000, closing_debit: 100_000 }),
      row('1229', { opening_credit: 60_000, closing_credit: 80_000 }),
      row('2153', { opening_credit: 30_000, closing_credit: 30_000 }),
    ])

    const result = await calculateOveravskrivningar({
      supabase: makeSupabase() as never,
      companyId: 'company-1',
      fiscalPeriod: PERIOD,
      entityType: 'aktiebolag',
    })

    expect(result.targetReserve).toBe(20_000)
    expect(result.proposal?.signedAmount).toBe(-10_000)
    expect(result.proposal?.required).toBe(true)
    expect(result.proposal?.lines.map((line) => line.account_number)).toEqual([
      '2153',
      '8853',
    ])
  })

  it('fails closed when the asset register does not reconcile to 12xx', async () => {
    const asset = makeAsset()
    vi.mocked(listAssets).mockResolvedValue([asset])
    mockTrialBalance([
      row('1220', { closing_debit: 90_000 }),
      row('1229', { closing_credit: 20_000 }),
    ])

    const result = await calculateOveravskrivningar({
      supabase: makeSupabase() as never,
      companyId: 'company-1',
      fiscalPeriod: PERIOD,
      entityType: 'aktiebolag',
    })

    expect(result.status).toBe('blocked')
    expect(result.warning).toContain('stämmer inte')
    expect(result.proposal).toBeNull()
    expect(proposeAnnualPostings).not.toHaveBeenCalled()
  })

  it('waits until current-period planned depreciation is posted', async () => {
    const asset = makeAsset()
    vi.mocked(listAssets).mockResolvedValue([asset])
    vi.mocked(proposeAnnualPostings).mockResolvedValue({
      fiscalPeriod: { ...PERIOD, name: '2026' },
      items: [
        {
          asset,
          amount: 20_000,
          netBookValueAfter: 80_000,
          proRated: false,
          existingJournalEntryId: null,
        },
      ],
      totalAmount: 20_000,
    })
    mockTrialBalance([row('1220', { closing_debit: 100_000 })])

    const result = await calculateOveravskrivningar({
      supabase: makeSupabase() as never,
      companyId: 'company-1',
      fiscalPeriod: PERIOD,
      entityType: 'aktiebolag',
    })

    expect(result.status).toBe('blocked')
    expect(result.warning).toContain('planenliga avskrivningarna först')
  })

  it('does not propose a second optional increase after one was posted this period', async () => {
    const asset = makeAsset()
    vi.mocked(listAssets).mockResolvedValue([asset])
    mockPostedDepreciation(asset)
    mockTrialBalance([
      row('1220', { period_debit: 100_000, closing_debit: 100_000 }),
      row('1229', { period_credit: 20_000, closing_credit: 20_000 }),
      row('2153', { period_credit: 5_000, closing_credit: 5_000 }),
    ])

    const result = await calculateOveravskrivningar({
      supabase: makeSupabase() as never,
      companyId: 'company-1',
      fiscalPeriod: PERIOD,
      entityType: 'aktiebolag',
    })

    expect(result.maximumSignedChange).toBe(5_000)
    expect(result.currentPeriodChange).toBe(5_000)
    expect(result.proposal).toBeNull()
  })

  it('does not calculate or query assets for a sole trader', async () => {
    const result = await calculateOveravskrivningar({
      supabase: makeSupabase() as never,
      companyId: 'company-1',
      fiscalPeriod: PERIOD,
      entityType: 'enskild_firma',
    })

    expect(result.status).toBe('not_applicable')
    expect(listAssets).not.toHaveBeenCalled()
    expect(generateTrialBalance).not.toHaveBeenCalled()
  })
})
