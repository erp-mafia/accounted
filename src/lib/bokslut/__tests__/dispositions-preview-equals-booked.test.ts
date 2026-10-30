/**
 * The bokslutsdispositioner preview (GET, buildDispositionsProposal) and the
 * commit (POST) compute each amount with the same per-kind functions
 * (avsattningDisposition, bolagsskattDisposition): the preview with the
 * proposals before it as pending, the POST after posting them, so the effect
 * has moved from pending to postedEffect. This pins that the amount booked
 * for each kind is the amount the preview showed.
 *
 * Before, the POST kept its own copy of both formulas. Its avsättning cap
 * base started from the income statement's result instead of resultat före
 * skatt, so a company with a manually posted 8910 (bolagsskatt booked outside
 * the flow) was previewed one avsättning and booked a smaller one.
 */
import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('@/lib/bokslut/tax-provision/bolagsskatt-calculator', () => ({
  // 20,6 % of the taxable base, the shape the real calculator returns.
  calculateBolagsskatt: vi.fn(async (_s, _c, _p, opts: { resultBeforeTaxOverride: number; manualAdjustments: Record<string, number> }) => {
    const m = opts.manualAdjustments
    const base = Math.max(0, Math.floor(
      opts.resultBeforeTaxOverride + m.nonDeductibleExpenses - m.nonTaxableIncome - m.deficitCarryforward
      + m.schablonintaktPeriodiseringsfond,
    ))
    const amount = Math.round(base * 0.206)
    return { kind: 'bolagsskatt', label: 'Bolagsskatt', amount, lines: [], warnings: [] }
  }),
  getBookedBolagsskatt: vi.fn(),
  sumPostedYearEndDispositions: vi.fn(),
}))

import { calculateBolagsskatt } from '@/lib/bokslut/tax-provision/bolagsskatt-calculator'
import {
  ateforingDispositions,
  avsattningDisposition,
  bolagsskattDisposition,
  type DispositionState,
} from '../dispositions-proposal-builder'

const supabase = {} as SupabaseClient

function stateWith(overrides: Partial<DispositionState> = {}): DispositionState {
  return {
    fiscalPeriodId: 'period-1',
    fiscalYear: 2025,
    netResult: 400_000,
    postedEffect: { total: 0, slpPortion: 0, taxProvisionPortion: 0 },
    taxAdjustments: { items: [], nonDeductibleExpenses: 12_000, nonTaxableIncome: 2_000, deficitCarryforward: 0 },
    // A manually posted 8910: in the income statement's result, not this flow's.
    incomeTaxInResult: 30_000,
    bookedTax: 30_000,
    existingFonder: [
      { account_number: '2129', cohort_year: 2019, balance: 60_000, opening_balance: 60_000, must_return_this_year: true },
    ],
    buildingTaxAdjustment: 0,
    ...overrides,
  }
}

describe('bokslutsdispositioner: the booked amount is the previewed amount', () => {
  it('for återföring, avsättning and bolagsskatt, committed in the canonical order', async () => {
    const slpAmount = 8_000

    // ---- Preview: nothing posted, earlier proposals pending ----
    const preview = stateWith()
    const ateforing = ateforingDispositions(preview, { schablonintaktRate: 0.025 })
    const ateforingTotal = ateforing.proposals.reduce((sum, p) => sum + p.amount, 0)
    expect(ateforingTotal).toBe(60_000)
    const previewAvsattning = avsattningDisposition(preview, {
      pendingResultEffect: ateforingTotal - slpAmount,
      schablonintaktAmount: ateforing.schablonintaktAmount,
    })
    const previewTax = await bolagsskattDisposition(supabase, 'company-1', preview, {
      pendingResultEffect: ateforingTotal - (previewAvsattning?.amount ?? 0) - slpAmount,
      schablonintaktAmount: ateforing.schablonintaktAmount,
    })

    // ---- Commit: återföring and SLP posted (their effect is in postedEffect) ----
    const afterAteforingAndSlp = stateWith({
      postedEffect: { total: ateforingTotal - slpAmount, slpPortion: -slpAmount, taxProvisionPortion: 0 },
      // The fond is returned: the closing balance is 0, the opening (the
      // schablonintäkt base) is unchanged.
      existingFonder: [
        { account_number: '2129', cohort_year: 2019, balance: 0, opening_balance: 60_000, must_return_this_year: true },
      ],
    })
    const bookedAvsattning = avsattningDisposition(afterAteforingAndSlp, {
      pendingResultEffect: 0,
      schablonintaktAmount: ateforingDispositions(afterAteforingAndSlp, { schablonintaktRate: 0.025 }).schablonintaktAmount,
    })
    expect(bookedAvsattning?.amount).toBe(previewAvsattning?.amount)
    expect(bookedAvsattning?.amount).toBeGreaterThan(0)

    // ---- Commit: avsättning posted too, bolagsskatt last ----
    const avsattningAmount = bookedAvsattning!.amount
    const beforeTax = stateWith({
      postedEffect: { total: ateforingTotal - slpAmount - avsattningAmount, slpPortion: -slpAmount, taxProvisionPortion: 0 },
      existingFonder: [
        { account_number: '2129', cohort_year: 2019, balance: 0, opening_balance: 60_000, must_return_this_year: true },
        { account_number: '2125', cohort_year: 2025, balance: avsattningAmount, opening_balance: 0, must_return_this_year: false },
      ],
    })
    const bookedTax = await bolagsskattDisposition(supabase, 'company-1', beforeTax, {
      pendingResultEffect: 0,
      schablonintaktAmount: ateforingDispositions(beforeTax, { schablonintaktRate: 0.025 }).schablonintaktAmount,
    })
    expect(bookedTax?.amount).toBe(previewTax?.amount)
    const overrides = vi.mocked(calculateBolagsskatt).mock.calls.map((c) => (c[3] as { resultBeforeTaxOverride: number }).resultBeforeTaxOverride)
    expect(overrides[1]).toBe(overrides[0])
  })

  it('adds a manually posted 8910 back into the avsättning cap base (the POST copy did not)', () => {
    const state = stateWith({ existingFonder: [] })
    const avsattning = avsattningDisposition(state, { pendingResultEffect: 0, schablonintaktAmount: 0 })
    // 25 % of (400 000 + 30 000 manual tax + 12 000 − 2 000).
    expect(avsattning?.amount).toBe(Math.floor(440_000 * 0.25))
    // The removed POST copy: 25 % of (400 000 + 12 000 − 2 000), 7 500 kr lower.
    expect(avsattning!.amount - Math.floor(410_000 * 0.25)).toBe(7_500)
  })
})

describe('bokslutsdispositioner: every income-tax account is added back (INK2 4.3a)', () => {
  const capFor = (incomeTaxInResult: number) =>
    avsattningDisposition(stateWith({ existingFonder: [], incomeTaxInResult }), {
      pendingResultEffect: 0,
      schablonintaktAmount: 0,
    })!.amount

  it('a manual deferred tax on 8940 raises the cap base by its amount', () => {
    // 8910 30 000 as before, plus 8940 10 000: 25 % of 10 000 more.
    expect(capFor(40_000) - capFor(30_000)).toBe(2_500)
  })

  it('a credit on 8920/8930 (tax income) lowers the cap base by its amount', () => {
    // 8910 30 000 and a 4 000 kr refund on 8930: the base drops by 4 000.
    expect(capFor(30_000) - capFor(26_000)).toBe(1_000)
  })

  it.each([
    { label: '8910 only', incomeTaxInResult: 30_000 },
    { label: '8910 and a deferred tax on 8940', incomeTaxInResult: 40_000 },
    { label: '8910 and a refund on 8930', incomeTaxInResult: 26_000 },
  ])('the booked bolagsskatt is the previewed one ($label)', async ({ incomeTaxInResult }) => {
    vi.mocked(calculateBolagsskatt).mockClear()
    const preview = stateWith({ existingFonder: [], incomeTaxInResult })
    const previewAvsattning = avsattningDisposition(preview, { pendingResultEffect: 0, schablonintaktAmount: 0 })!
    const previewTax = await bolagsskattDisposition(supabase, 'company-1', preview, {
      pendingResultEffect: -previewAvsattning.amount,
      schablonintaktAmount: 0,
    })

    const posted = stateWith({
      existingFonder: [
        { account_number: '2125', cohort_year: 2025, balance: previewAvsattning.amount, opening_balance: 0, must_return_this_year: false },
      ],
      incomeTaxInResult,
      postedEffect: { total: -previewAvsattning.amount, slpPortion: 0, taxProvisionPortion: 0 },
    })
    const bookedTax = await bolagsskattDisposition(supabase, 'company-1', posted, {
      pendingResultEffect: 0,
      schablonintaktAmount: 0,
    })

    expect(bookedTax?.amount).toBe(previewTax?.amount)
    const [previewBase, bookedBase] = vi.mocked(calculateBolagsskatt).mock.calls.map(
      (c) => (c[3] as { resultBeforeTaxOverride: number }).resultBeforeTaxOverride,
    )
    expect(bookedBase).toBe(previewBase)
    // Net result 400 000 plus every income-tax amount, less the avsättning.
    expect(previewBase).toBe(400_000 + incomeTaxInResult - previewAvsattning.amount)
  })
})
