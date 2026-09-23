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
  it.each([
    { sum: 1.57 + 0.43, expected: '2' },
    { sum: 1033.54 + 1203.03 + 259.43, expected: '2496' },
    { sum: 1668.37 + 210.04 + 132.59, expected: '2011' },
    { sum: 1686 + 1275.82 + 688.18, expected: '3650' },
  ])('formats the drifting SRU sum as $expected kronor', ({ sum, expected }) => {
    expect(sruAmount(sum)).toBe(expected)
    expect(sruAmount(-sum)).toBe(`-${expected}`)
  })

  it.each([
    { amount: 0, expected: '0' },
    { amount: -0, expected: '0' },
    { amount: 2496, expected: '2496' },
    { amount: -2496, expected: '-2496' },
    { amount: 2495.99, expected: '2495' },
    { amount: -2495.99, expected: '-2495' },
    { amount: 0.99, expected: '0' },
    { amount: -0.99, expected: '0' },
  ])('drops genuine öre from $amount and normalizes zero', ({ amount, expected }) => {
    expect(sruAmount(amount)).toBe(expected)
  })

  it.each([
    { surplus: 10209.31, priorSchablon: 1854.55, priorActual: 43.86, net: 12020, expected: 3005 },
    { surplus: 4721.11, priorSchablon: 1915.69, priorActual: 1804.80, net: 4832, expected: 1208 },
    { surplus: 3507.45, priorSchablon: 466.53, priorActual: 421.98, net: 3552, expected: 888 },
  ])('keeps R43 at $expected for net surplus $net', ({ surplus, priorSchablon, priorActual, net, expected }) => {
    const result = calculateEgenavgifter({
      surplusBeforeEgenavgifter: surplus,
      priorYearSchablonavdrag: priorSchablon,
      priorYearActualCharged: priorActual,
    })
    expect(result.ne_ruta).toBe('R43')
    expect(result.amount).toBe(expected)
    expect(result.computation).toMatchObject({ netSurplusForSchablon: net, schablonavdrag: expected })
  })

  it.each([
    { category: 'pensioner' as const, expected: 1202 },
    { category: 'passive' as const, expected: 2404 },
  ])('keeps the $category schablonavdrag at $expected', ({ category, expected }) => {
    const result = calculateEgenavgifter({
      surplusBeforeEgenavgifter: 10209.31,
      priorYearSchablonavdrag: 1854.55,
      priorYearActualCharged: 43.86,
      category,
    })
    expect(result.amount).toBe(expected)
  })

  it.each([
    { surplus: 12020, expected: 3005 },
    { surplus: 12019.99, expected: 3004 },
    { surplus: 0, expected: 0 },
    { surplus: -12020, expected: 0 },
  ])('preserves the deduction for surplus $surplus', ({ surplus, expected }) => {
    expect(calculateEgenavgifter({ surplusBeforeEgenavgifter: surplus }).amount).toBe(expected)
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

  it('counts the full already-provisioned amount against the cap', () => {
    const proposal = proposeAvsattning({
      skattemassigtResultatBeforeAvsattning: 10_000,
      alreadyProvisioned: 1033.54 + 1203.03 + 259.43,
      fiscalYear: 2026,
    })
    expect(proposal?.amount).toBe(4)
    expect(proposal?.computation).toMatchObject({ alreadyProvisioned: 2496, maxAmount: 2500 })
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
    expect(proposal?.amount).toBe(11_559)
    expect(proposal?.lines).toEqual([
      expect.objectContaining({ account_number: '8910', debit_amount: 11_559, credit_amount: 0 }),
      expect.objectContaining({ account_number: '2512', debit_amount: 0, credit_amount: 11_559 }),
    ])
  })

  it.each([
    { result: 56_110, base: 56_110, tax: 11_559 },
    { result: 56_109.99, base: 56_100, tax: 11_557 },
    { result: 56_119.99, base: 56_110, tax: 11_559 },
    { result: 0, base: 0, tax: 0 },
    { result: -56_110, base: 0, tax: 0 },
  ])('preserves tax $tax on non-drifting result $result', async ({ result, base, tax }) => {
    const proposal = await calculateBolagsskatt(null as never, 'company-1', 'period-1', {
      resultBeforeTaxOverride: result,
    })
    expect(proposal?.computation).toMatchObject({ taxableResult: result, taxableResultClamped: base })
    expect(proposal?.amount).toBe(tax)
  })
})
