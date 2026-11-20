import { roundOre } from '@/lib/money'

/**
 * Löneväxling till pension: salary sacrifice to occupational pension.
 *
 * The 1.058 factor: For every 1 SEK salary reduction, pension contribution
 * should be 1.058 SEK to make the employee roughly cost-neutral
 * (because reduced salary → reduced avgifter for employer).
 */

export interface LoneVaxlingPensionProvision {
  salaryReduction: number
  pensionContribution: number
  slpOnPension: number
}

/**
 * Calculate the journal amounts created by a pension salary exchange.
 */
export function calculateLoneVaxlingPensionProvision(
  reductionAmount: number,
  slpRate: number,
): LoneVaxlingPensionProvision {
  if (!Number.isFinite(slpRate) || slpRate < 0 || slpRate > 1) {
    throw new Error('Payroll configuration has an invalid SLP rate')
  }

  const salaryReduction = roundOre(Math.abs(reductionAmount))
  const pensionContribution = roundOre(salaryReduction * 1.058)
  const slpOnPension = roundOre(pensionContribution * slpRate)

  return { salaryReduction, pensionContribution, slpOnPension }
}
