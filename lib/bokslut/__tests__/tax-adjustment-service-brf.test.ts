/**
 * Bostadsrättsförening in the tax adjustment snapshot: the äkta year's
 * property block becomes two detected items (IL 39 kap. 25 §, INK2S
 * 4.3c/4.5c), an oäkta year gets none, and a year without an assessment in
 * brf_tax_profiles gets none plus the 'unassessed' status.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/reports/trial-balance', () => ({
  generateTrialBalance: vi.fn(),
}))
vi.mock('@/lib/company/brf-tax-profile', () => ({
  getTaxProfile: vi.fn(),
}))

import { generateTrialBalance } from '@/lib/reports/trial-balance'
import { getTaxProfile } from '@/lib/company/brf-tax-profile'
import { loadTaxAdjustmentSnapshot, saveTaxAdjustments } from '../tax-provision/tax-adjustment-service'

const upserts: unknown[][] = []

function makeClient(persisted: unknown[] = []) {
  return {
    from: (table: string) => {
      if (table === 'fiscal_periods') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: { period_end: '2026-12-31' }, error: null }),
              }),
            }),
          }),
        }
      }
      if (table === 'fiscal_period_tax_adjustments') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => Promise.resolve({ data: persisted, error: null }),
            }),
          }),
          upsert: async (rows: unknown[]) => {
            upserts.push(rows)
            return { error: null }
          },
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  } as unknown as Parameters<typeof loadTaxAdjustmentSnapshot>[0]
}

const ROWS = [
  { account_number: '3020', closing_debit: 0, closing_credit: 2_400_000 },
  { account_number: '6992', closing_debit: 1_000, closing_credit: 0 },
  { account_number: '7830', closing_debit: 900_000, closing_credit: 0 },
  { account_number: '8311', closing_debit: 0, closing_credit: 12_000 },
  { account_number: '8410', closing_debit: 800_000, closing_credit: 0 },
]

beforeEach(() => {
  vi.clearAllMocks()
  upserts.length = 0
  vi.mocked(generateTrialBalance).mockResolvedValue({
    rows: ROWS,
    totalDebit: 0,
    totalCredit: 0,
    isBalanced: true,
  } as unknown as Awaited<ReturnType<typeof generateTrialBalance>>)
})

describe('loadTaxAdjustmentSnapshot for a bostadsrättsförening', () => {
  it('adds the property block for an äkta year and keeps 6992 as its own item', async () => {
    vi.mocked(getTaxProfile).mockResolvedValue({ privatbostadsforetag: true } as never)
    const snapshot = await loadTaxAdjustmentSnapshot(makeClient(), 'co', 'fp', 'bostadsrattsforening')

    expect(vi.mocked(getTaxProfile)).toHaveBeenCalledWith(expect.anything(), 'co', 2026)
    expect(snapshot.brf).toEqual({
      taxationYear: 2026,
      status: 'akta',
      propertyIncome: 2_400_000,
      propertyCosts: 1_000 + 900_000 + 800_000,
      taxableCapitalIncome: 12_000,
    })
    const income = snapshot.items.find((i) => i.sourceKey === 'brf:property_income')!
    const costs = snapshot.items.find((i) => i.sourceKey === 'brf:property_costs')!
    expect(income).toMatchObject({ source: 'detected', accountNumber: null, included: true, amount: 2_400_000 })
    expect(costs).toMatchObject({ adjustmentType: 'non_deductible_expense', included: true, amount: 1_701_000 })
    // 6992 stays a separate account item; its 1 000 kr is also inside the block,
    // which the reviewer sees in both lines (the block is switched off when the
    // account-level split is preferred).
    expect(snapshot.nonTaxableIncome).toBe(2_400_000)
    expect(snapshot.nonDeductibleExpenses).toBe(1_701_000 + 1_000)
    // The block is read from the pre-closing books.
    expect(vi.mocked(generateTrialBalance)).toHaveBeenCalledWith(expect.anything(), 'co', 'fp', {
      closingEntry: 'exclude-final',
    })
  })

  it('honours a persisted exclusion of a block item', async () => {
    vi.mocked(getTaxProfile).mockResolvedValue({ privatbostadsforetag: true } as never)
    const snapshot = await loadTaxAdjustmentSnapshot(
      makeClient([{ source_key: 'brf:property_income', included: false, amount: 0 }]),
      'co',
      'fp',
      'bostadsrattsforening',
    )
    expect(snapshot.items.find((i) => i.sourceKey === 'brf:property_income')!.included).toBe(false)
    expect(snapshot.nonTaxableIncome).toBe(0)
    expect(snapshot.nonDeductibleExpenses).toBe(1_702_000)
  })

  it('adds nothing for an oäkta year but still reports the status', async () => {
    vi.mocked(getTaxProfile).mockResolvedValue({ privatbostadsforetag: false } as never)
    const snapshot = await loadTaxAdjustmentSnapshot(makeClient(), 'co', 'fp', 'bostadsrattsforening')
    expect(snapshot.brf).toMatchObject({ status: 'oakta', propertyIncome: 0, propertyCosts: 0 })
    expect(snapshot.items.some((i) => i.sourceKey.startsWith('brf:'))).toBe(false)
    expect(snapshot.nonTaxableIncome).toBe(0)
    expect(snapshot.nonDeductibleExpenses).toBe(1_000)
  })

  it('applies no exemption when the year is unassessed', async () => {
    vi.mocked(getTaxProfile).mockResolvedValue(null)
    const snapshot = await loadTaxAdjustmentSnapshot(makeClient(), 'co', 'fp', 'bostadsrattsforening')
    expect(snapshot.brf?.status).toBe('unassessed')
    expect(snapshot.items.some((i) => i.sourceKey.startsWith('brf:'))).toBe(false)
    expect(snapshot.nonTaxableIncome).toBe(0)
  })

  it('never reads the profile for an ekonomisk förening', async () => {
    const snapshot = await loadTaxAdjustmentSnapshot(makeClient(), 'co', 'fp', 'ekonomisk_forening')
    expect(vi.mocked(getTaxProfile)).not.toHaveBeenCalled()
    expect(snapshot.brf).toBeUndefined()
  })
})

describe('saveTaxAdjustments for an äkta bostadsrättsförening', () => {
  it('persists the block items keyed by source key with the reviewer toggle', async () => {
    vi.mocked(getTaxProfile).mockResolvedValue({ privatbostadsforetag: true } as never)
    await saveTaxAdjustments(
      makeClient(),
      'co',
      'fp',
      'user-1',
      {
        manualAdjustments: { nonDeductibleExpenses: 0, nonTaxableIncome: 0 },
        detectedAccounts: { '6992': true },
        detectedItems: { 'brf:property_costs': false },
      },
      'bostadsrattsforening',
    )
    const rows = upserts[0] as Array<{ source_key: string; included: boolean; account_number: string | null; amount: number }>
    const income = rows.find((r) => r.source_key === 'brf:property_income')!
    const costs = rows.find((r) => r.source_key === 'brf:property_costs')!
    expect(income).toMatchObject({ included: true, account_number: null, amount: 2_400_000 })
    expect(costs).toMatchObject({ included: false, account_number: null, amount: 1_701_000 })
    expect(rows.find((r) => r.source_key === 'account:6992')!.included).toBe(true)
  })
})
