import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'

/**
 * Uppskjuten skatt (BFNAR 2012:1 kap. 29): temporary differences (29.14),
 * the deferred tax at the rate (29.25), net presentation on 2240/1370
 * (29.32) with the change on 8940 (29.22), a loss carried forward only when
 * recognised (29.29), and nothing in a K2 year.
 */

const trialBalanceMock = vi.fn()
vi.mock('@/lib/reports/trial-balance', () => ({
  generateTrialBalance: (...args: unknown[]) => trialBalanceMock(...args),
}))

const {
  deferredTaxItem,
  deferredTaxPosting,
  lossCarryforwardDifference,
  temporaryDifference,
} = await import('../deferred-tax')
const { buildDeferredTaxProposal, closingDeficitOf, deferredTaxItems, DeferredTaxAssessmentSchema, saveDeferredTaxAssessment } =
  await import('../deferred-tax-service')

function balanceRows(rows: Array<{ account: string; debit?: number; credit?: number; openingDebit?: number; openingCredit?: number }>) {
  return {
    rows: rows.map((row) => ({
      account_number: row.account,
      account_name: row.account,
      account_class: 1,
      opening_debit: row.openingDebit ?? 0,
      opening_credit: row.openingCredit ?? 0,
      period_debit: 0,
      period_credit: 0,
      closing_debit: row.debit ?? 0,
      closing_credit: row.credit ?? 0,
    })),
    totalDebit: 0,
    totalCredit: 0,
    isBalanced: true,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  trialBalanceMock.mockResolvedValue(balanceRows([]))
})

describe('temporary differences (K3 29.14)', () => {
  it('is taxable when an asset is carried above its tax value, deductible below; the reverse for a liability', () => {
    expect(temporaryDifference({ nature: 'asset', carryingAmount: 900_000, taxValue: 800_000 })).toBe(100_000)
    expect(temporaryDifference({ nature: 'asset', carryingAmount: 700_000, taxValue: 800_000 })).toBe(-100_000)
    expect(temporaryDifference({ nature: 'liability', carryingAmount: 50_000, taxValue: 0 })).toBe(-50_000)
  })

  it('gives the deferred tax at the rate, a loss carried forward as a deductible difference', () => {
    expect(
      deferredTaxItem({ kind: 'manual', label: ' Byggnad ', nature: 'asset', carryingAmount: 900_000, taxValue: 800_000 }, 0.206),
    ).toEqual({
      kind: 'manual',
      label: 'Byggnad',
      carrying_amount: 900_000,
      tax_value: 800_000,
      temporary_difference: 100_000,
      tax_rate: 0.206,
      deferred_tax: 20_600,
    })
    expect(deferredTaxItem(lossCarryforwardDifference(250_000), 0.206).deferred_tax).toBe(-51_500)
  })
})

describe('the deferred tax voucher (K3 29.22, 29.32)', () => {
  it('books a new asset on 1370 against 8940', () => {
    const posting = deferredTaxPosting({ liability: 0, asset: 0 }, -20_600)
    expect(posting).toMatchObject({ opening: 0, closing: -20_600, change: -20_600 })
    expect(posting.lines).toEqual([
      expect.objectContaining({ account_number: '8940', debit_amount: 0, credit_amount: 20_600 }),
      expect.objectContaining({ account_number: '1370', debit_amount: 20_600, credit_amount: 0 }),
    ])
  })

  it('moves a liability to an asset, presented net', () => {
    const posting = deferredTaxPosting({ liability: 10_000, asset: 0 }, -5_000)
    expect(posting.change).toBe(-15_000)
    expect(posting.lines).toEqual([
      expect.objectContaining({ account_number: '8940', credit_amount: 15_000 }),
      expect.objectContaining({ account_number: '2240', debit_amount: 10_000 }),
      expect.objectContaining({ account_number: '1370', debit_amount: 5_000 }),
    ])
  })

  it('nets a gross balance without touching the result, and posts nothing when it already stands', () => {
    const netting = deferredTaxPosting({ liability: 8_000, asset: 3_000 }, 5_000)
    expect(netting.change).toBe(0)
    expect(netting.lines).toEqual([
      expect.objectContaining({ account_number: '2240', debit_amount: 3_000 }),
      expect.objectContaining({ account_number: '1370', credit_amount: 3_000 }),
    ])
    expect(deferredTaxPosting({ liability: 5_000, asset: 0 }, 5_000).lines).toEqual([])
  })
})

describe('the year\'s temporary differences', () => {
  it('recognises the loss only when judged recoverable, and takes the manual ones', () => {
    const manual = [{ label: 'Garantiavsättning', nature: 'liability' as const, carrying_amount: 40_000, tax_value: 0 }]
    expect(deferredTaxItems({ loss_recognised: false, loss_reason: null, manual_items: [] }, 100_000)).toEqual([])
    const items = deferredTaxItems({ loss_recognised: true, loss_reason: 'Ny storkund', manual_items: manual }, 100_000)
    expect(items.map((item) => [item.kind, item.deferred_tax])).toEqual([
      ['loss_carryforward', -20_600],
      ['manual', -8_240],
    ])
  })

  it('carries the 29.29 reason onto the loss item, the snapshot commit_deferred_tax keeps', () => {
    const [loss] = deferredTaxItems({ loss_recognised: true, loss_reason: '  Ny storkund  ', manual_items: [] }, 100_000)
    expect(loss).toMatchObject({ kind: 'loss_carryforward', reason: 'Ny storkund' })
    const [manual] = deferredTaxItems(
      { loss_recognised: false, loss_reason: null, manual_items: [{ label: 'Garanti', nature: 'liability', carrying_amount: 10_000, tax_value: 0 }] },
      0,
    )
    expect(manual).not.toHaveProperty('reason')
  })

  it('takes a building\'s carrying amount against its tax value on the tax plan', () => {
    const items = deferredTaxItems({ loss_recognised: false, loss_reason: null, manual_items: [] }, 0, 0.206, [
      { kind: 'building', label: 'Kontorshus', nature: 'asset', carryingAmount: 900_000, taxValue: 860_000 },
    ])
    expect(items).toEqual([
      expect.objectContaining({ kind: 'building', temporary_difference: 40_000, deferred_tax: 8_240 }),
    ])
  })

  it('reads the closing underskott off the bolagsskatt computation', () => {
    expect(closingDeficitOf({ computation: { taxableResult: -125_000.5 } } as never)).toBe(125_000.5)
    expect(closingDeficitOf({ computation: { taxableResult: 40_000 } } as never)).toBe(0)
    expect(closingDeficitOf(null)).toBe(0)
  })

  it('wants a reason to recognise a loss (K3 29.29)', () => {
    expect(DeferredTaxAssessmentSchema.safeParse({ loss_recognised: true, manual_items: [] }).success).toBe(false)
    expect(
      DeferredTaxAssessmentSchema.safeParse({ loss_recognised: true, loss_reason: 'Ny storkund', manual_items: [] }).success,
    ).toBe(true)
  })
})

describe('buildDeferredTaxProposal', () => {
  // B1: the company column is the LATEST year's framework. A K2 year still
  // open while the next year is elected K3 gets no deferred tax, and the
  // inputs are refused; the K3 year itself still works.
  it('proposes nothing in a K2 year whose next year is K3, and still proposes in the K3 year', async () => {
    const k2Year = createTableMockSupabase({
      fiscal_period_frameworks: { data: { fiscal_period_id: 'fy-2026', framework: 'k2', source: 'company_default' } },
      fiscal_periods: { data: { id: 'fy-2026', is_closed: false, locked_at: null, closing_entry_id: null } },
      companies: { data: { accounting_framework: 'k3' } },
      deferred_tax_assessments: { data: { loss_recognised: true, loss_reason: 'Ny storkund', manual_items: [] } },
    })
    expect(await buildDeferredTaxProposal(k2Year.supabase as never, 'co-1', 'fy-2026', { closingDeficit: 100_000 })).toBeNull()
    await expect(
      saveDeferredTaxAssessment(k2Year.supabase as never, 'co-1', 'user-1', 'fy-2026', {
        loss_recognised: false,
        loss_reason: null,
        manual_items: [],
      }),
    ).rejects.toMatchObject({ code: 'DEFERRED_TAX_NOT_APPLICABLE' })

    const k3Year = createTableMockSupabase({
      fiscal_period_frameworks: { data: { fiscal_period_id: 'fy-2027', framework: 'k3', source: 'election' } },
      companies: { data: { accounting_framework: 'k3' } },
      deferred_tax_assessments: { data: { loss_recognised: true, loss_reason: 'Ny storkund', manual_items: [] } },
    })
    const built = await buildDeferredTaxProposal(k3Year.supabase as never, 'co-1', 'fy-2027', { closingDeficit: 100_000 })
    expect(built?.proposal).toMatchObject({ kind: 'uppskjuten_skatt_kap29' })
  })

  it('proposes nothing in a K2 year', async () => {
    const { supabase } = createTableMockSupabase({ companies: { data: { accounting_framework: 'k2' } } })
    expect(await buildDeferredTaxProposal(supabase as never, 'co-1', 'fy-2026', { closingDeficit: 100_000 })).toBeNull()
  })

  it('proposes the change from what the ledger holds to the computed deferred tax', async () => {
    const { supabase } = createTableMockSupabase({
      companies: { data: { accounting_framework: 'k3' } },
      deferred_tax_assessments: { data: { loss_recognised: true, loss_reason: 'Ny storkund', manual_items: [] } },
    })
    trialBalanceMock.mockResolvedValue(balanceRows([{ account: '1370', debit: 10_000 }]))
    const built = await buildDeferredTaxProposal(supabase as never, 'co-1', 'fy-2026', { closingDeficit: 100_000 })
    expect(built?.snapshot).toMatchObject({ opening: -10_000, closing: -20_600, change: -10_600, closingDeficit: 100_000 })
    expect(built?.proposal).toMatchObject({ kind: 'uppskjuten_skatt_kap29', amount: 10_600, signedAmount: -10_600 })
    expect(built?.proposal?.lines).toEqual([
      expect.objectContaining({ account_number: '8940', credit_amount: 10_600 }),
      expect.objectContaining({ account_number: '1370', debit_amount: 10_600 }),
    ])
  })

  it('answers the snapshot without a proposal when nothing changes', async () => {
    const { supabase } = createTableMockSupabase({
      companies: { data: { accounting_framework: 'k3' } },
      deferred_tax_assessments: { data: null },
    })
    const built = await buildDeferredTaxProposal(supabase as never, 'co-1', 'fy-2026', { closingDeficit: 0 })
    expect(built).toMatchObject({ proposal: null, snapshot: { items: [], change: 0, needsInputs: false } })
  })

  // B1: an SIE import or a voucher booked by hand left deferred tax on
  // 2240/1370 that no input explains. Without the year's inputs the closing
  // would be zero and the default "Bokför" would reverse the whole balance
  // through 8940.
  it('proposes nothing while the ledger holds deferred tax and the year has no saved inputs', async () => {
    const { supabase } = createTableMockSupabase({
      companies: { data: { accounting_framework: 'k3' } },
      deferred_tax_assessments: { data: null },
    })
    trialBalanceMock.mockResolvedValue(balanceRows([{ account: '2240', credit: 50_000 }]))
    const built = await buildDeferredTaxProposal(supabase as never, 'co-1', 'fy-2026', { closingDeficit: 0 })
    expect(built?.proposal).toBeNull()
    expect(built?.snapshot).toMatchObject({ needsInputs: true, opening: 50_000, closing: 0, change: -50_000 })
  })

  it('holds a recognised loss asset too, even with a deficit the loss would cover', async () => {
    const { supabase } = createTableMockSupabase({
      companies: { data: { accounting_framework: 'k3' } },
      deferred_tax_assessments: { data: null },
    })
    trialBalanceMock.mockResolvedValue(balanceRows([{ account: '1370', debit: 20_600 }]))
    const built = await buildDeferredTaxProposal(supabase as never, 'co-1', 'fy-2026', { closingDeficit: 100_000 })
    expect(built?.proposal).toBeNull()
    expect(built?.snapshot.needsInputs).toBe(true)
  })

  it('proposes again once the inputs are saved, even when they bring the balance down', async () => {
    const { supabase } = createTableMockSupabase({
      companies: { data: { accounting_framework: 'k3' } },
      deferred_tax_assessments: { data: { loss_recognised: false, loss_reason: null, manual_items: [] } },
    })
    trialBalanceMock.mockResolvedValue(balanceRows([{ account: '2240', credit: 50_000 }]))
    const built = await buildDeferredTaxProposal(supabase as never, 'co-1', 'fy-2026', { closingDeficit: 0 })
    expect(built?.snapshot.needsInputs).toBe(false)
    expect(built?.proposal).toMatchObject({ amount: 50_000, signedAmount: -50_000 })
  })
})
