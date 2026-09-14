import { describe, it, expect } from 'vitest'
import { sruAmount } from '@/lib/reports/sru/format'
import { calculateEgenavgifter } from '@/lib/bokslut/enskild-firma/egenavgifter-calculator'
import { proposeAvsattning } from '@/lib/bokslut/reserves/periodiseringsfond-service'
import { calculateBolagsskatt } from '@/lib/bokslut/tax-provision/bolagsskatt-calculator'

/**
 * One file for one bug class rather than one per module (#2597): every case
 * below is the same defect, a whole-krona floor or truncation applied to a sum
 * of doubles that landed just under an integer. Splitting them across four
 * __tests__ directories would hide that they stand or fall together.
 *
 * The inputs are not hand-picked edge cases. They were found by searching
 * ordinary two-decimal amounts, which is the point: this needs no unusual
 * data to fire.
 *
 * The one member of the class that is not here is the INK2 engine, whose
 * regression sits in lib/reports/ink2/__tests__/ink2-declaration.test.ts
 * because it needs that file's trial-balance fixtures.
 */
describe('whole-krona rounding survives double drift (#2597)', () => {
  it('files the SRU amount that the öre actually add up to', () => {
    // 1.57 + 0.43 is 1.99999999999999978 as a double. Math.trunc filed 1.
    expect(sruAmount(1.57 + 0.43)).toBe('2')
    expect(sruAmount(1033.54 + 1203.03 + 259.43)).toBe('2496')
    // Negative amounts truncate toward zero, not away from it.
    expect(sruAmount(-(1.57 + 0.43))).toBe('-2')
    // And an amount with real öre still drops them.
    expect(sruAmount(2495.67)).toBe('2495')
    expect(sruAmount(-2495.67)).toBe('-2495')
  })

  it('does not take the schablonavdrag a krona low', () => {
    // 10209.31 + 1854.55 - 43.86 is 12019.9999999999982, and 25 % of that
    // floored gave 3004 instead of 3005.
    const result = calculateEgenavgifter({
      surplusBeforeEgenavgifter: 10209.31,
      priorYearSchablonavdrag: 1854.55,
      priorYearActualCharged: 43.86,
    })
    expect(result.amount).toBe(3005)   // R43
  })

  it('keeps the schablonavdrag correct for the reduced categories too', () => {
    // The rate is not the problem (0.10 and 0.20 floor correctly on whole
    // kronor), but the drifting sum reaches them the same way.
    const pensioner = calculateEgenavgifter({
      surplusBeforeEgenavgifter: 10209.31,
      priorYearSchablonavdrag: 1854.55,
      priorYearActualCharged: 43.86,
      category: 'pensioner',
    })
    expect(pensioner.amount).toBe(1202)
  })

  it('bases the periodiseringsfond cap on the krona the result reaches', () => {
    // A six-term taxable result landing at 88027.9999999999854 floored to
    // 88027, taking the 25 % cap to 22006 instead of 22007. The krona only
    // survives the cap when the true base is a multiple of four, which is why
    // this needed searching for rather than the first drifting value.
    const proposal = proposeAvsattning({
      skattemassigtResultatBeforeAvsattning: 88027.9999999999854,
      desiredAmount: 999_999,
      fiscalYear: 2026,
    })
    expect(proposal?.amount).toBe(22007)
  })

  it('does not clamp the bolagsskatt base a whole ten too low', async () => {
    // The only site in the class that floors to TENS rather than to kronor,
    // so the same drift costs 10 kr of base, not 1. These five adjustment
    // terms sum to 56109.99999999999, which clamped to 56100.
    const proposal = await calculateBolagsskatt(
      null as never,
      'company-1',
      'period-1',
      {
        resultBeforeTaxOverride: 715.21,
        manualAdjustments: {
          nonDeductibleExpenses: 19_196.29 + 1_515.44,
          schablonintaktPeriodiseringsfond: 19_658.68,
          other: 15_024.38,
        },
      },
    )

    const computation = proposal?.computation as { taxableResultClamped: number } | undefined
    expect(computation?.taxableResultClamped).toBe(56_110)
    expect(proposal?.amount).toBe(Math.round(56_110 * 0.206))
  })
})
