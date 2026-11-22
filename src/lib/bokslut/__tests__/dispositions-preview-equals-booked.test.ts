/**
 * The bokslutsdispositioner preview (GET, buildDispositionsProposal) and the
 * commit (POST) compute each amount with the same per-kind functions
 * (avsattningDisposition, bolagsskattDisposition): the preview with the
 * proposals before it as pending, the POST after posting them, so the effect
 * has moved from pending into the year's result. This pins that the amount
 * booked for each kind is the amount the preview showed.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/bokslut/tax-provision/bolagsskatt-calculator', () => ({
  // 20,6 % of the taxable base, the shape the real calculator returns.
  calculateBolagsskatt: vi.fn((opts: { resultBeforeTax: number; manualAdjustments: Record<string, number> }) => {
    const m = opts.manualAdjustments
    const base = Math.max(0, Math.floor(
      opts.resultBeforeTax + m.nonDeductibleExpenses - m.nonTaxableIncome - m.deficitCarryforward
      + m.schablonintaktPeriodiseringsfond + m.uppraekningPeriodiseringsfond,
    ))
    const amount = Math.round(base * 0.206)
    return { kind: 'bolagsskatt', label: 'Bolagsskatt', amount, lines: [], warnings: [] }
  }),
  getBookedBolagsskatt: vi.fn(),
}))

import { calculateBolagsskatt } from '@/lib/bokslut/tax-provision/bolagsskatt-calculator'
import {
  ateforingDispositions,
  avsattningDisposition,
  bolagsskattDisposition,
  fondUppraekning,
  type DispositionState,
} from '../dispositions-proposal-builder'

function stateWith(overrides: Partial<DispositionState> = {}): DispositionState {
  return {
    fiscalPeriodId: 'period-1',
    fiscalYear: 2025,
    result: { beforeDispositions: 430_000, beforeTax: 430_000 },
    taxAdjustments: { items: [], nonDeductibleExpenses: 12_000, nonTaxableIncome: 2_000, deficitCarryforward: 0 },
    bookedTax: 0,
    existingFonder: [
      { account_number: '2129', cohort_year: 2019, balance: 60_000, opening_balance: 60_000, must_return_this_year: true },
    ],
    buildingTaxAdjustment: 0,
    periodStart: '2025-01-01',
    taxYears: [],
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
    // The 2019 fond was set aside for a beskattningsår that began 2019-01-01:
    // återförd at 104 %, so 4.6d is 2 400 kr, pending like the återföring.
    expect(ateforing.uppraekning.amount).toBe(2_400)
    const previewAvsattning = avsattningDisposition(preview, {
      pendingResultEffect: ateforingTotal - slpAmount,
      schablonintaktAmount: ateforing.schablonintaktAmount,
      uppraekningAmount: ateforing.uppraekning.amount,
    })
    const previewTax = bolagsskattDisposition(preview, {
      pendingResultEffect: ateforingTotal - (previewAvsattning?.amount ?? 0) - slpAmount,
      schablonintaktAmount: ateforing.schablonintaktAmount,
      uppraekningAmount: ateforing.uppraekning.amount,
    })

    // ---- Commit: återföring and SLP posted (their effect is in the result) ----
    const afterAteforingAndSlp = stateWith({
      result: { beforeDispositions: 430_000 - slpAmount, beforeTax: 430_000 + ateforingTotal - slpAmount },
      // The fond is returned: the closing balance is 0, the opening (the
      // schablonintäkt base) is unchanged.
      existingFonder: [
        { account_number: '2129', cohort_year: 2019, balance: 0, opening_balance: 60_000, must_return_this_year: true },
      ],
    })
    // Booked, the återföring is no longer pending; the uppräkning follows it.
    expect(fondUppraekning(afterAteforingAndSlp).amount).toBe(2_400)
    const bookedAvsattning = avsattningDisposition(afterAteforingAndSlp, {
      pendingResultEffect: 0,
      schablonintaktAmount: ateforingDispositions(afterAteforingAndSlp, { schablonintaktRate: 0.025 }).schablonintaktAmount,
      uppraekningAmount: fondUppraekning(afterAteforingAndSlp).amount,
    })
    expect(bookedAvsattning?.amount).toBe(previewAvsattning?.amount)
    expect(bookedAvsattning?.amount).toBeGreaterThan(0)

    // ---- Commit: avsättning posted too, bolagsskatt last ----
    const avsattningAmount = bookedAvsattning!.amount
    const beforeTax = stateWith({
      result: { beforeDispositions: 430_000 - slpAmount, beforeTax: 430_000 + ateforingTotal - slpAmount - avsattningAmount },
      existingFonder: [
        { account_number: '2129', cohort_year: 2019, balance: 0, opening_balance: 60_000, must_return_this_year: true },
        { account_number: '2125', cohort_year: 2025, balance: avsattningAmount, opening_balance: 0, must_return_this_year: false },
      ],
    })
    const bookedTax = bolagsskattDisposition(beforeTax, {
      pendingResultEffect: 0,
      schablonintaktAmount: ateforingDispositions(beforeTax, { schablonintaktRate: 0.025 }).schablonintaktAmount,
      uppraekningAmount: fondUppraekning(beforeTax).amount,
    })
    expect(bookedTax.amount).toBe(previewTax.amount)
    const bases = vi.mocked(calculateBolagsskatt).mock.calls.map(([input]) => input.resultBeforeTax)
    expect(bases[1]).toBe(bases[0])
  })
})
