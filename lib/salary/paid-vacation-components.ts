import { roundOre } from '@/lib/money'

/** Explicit agreement inputs for a monthly employee. A partial sickness
 * period can change the salary displaced by vacation without changing the
 * earned vacation-pay basis. Never infer those bases from a target total. */
export function paidVacationComponents(input: {
  days: number
  payBasis: number
  deductionBasis?: number
  supplementBasis?: number
  supplementRate: number
  dayRate?: number
  rounding: 'aggregate_supplement' | 'separate_daily' | 'combined_daily'
}) {
  const { days, payBasis, supplementRate } = input
  const deductionBasis = input.deductionBasis ?? payBasis
  const supplementBasis = input.supplementBasis ?? payBasis
  const dayRate = input.dayRate ?? 0.046
  if ([days, payBasis, deductionBasis, supplementBasis, supplementRate, dayRate].some(x => !Number.isFinite(x) || x < 0)) {
    throw new Error('Ogiltigt underlag för betald semester')
  }
  const vacationPay = roundOre(roundOre(payBasis * dayRate) * days)
  const salaryDeduction = roundOre(roundOre(deductionBasis * dayRate) * days)
  const supplement = input.rounding === 'aggregate_supplement'
    ? roundOre(supplementBasis * supplementRate * days)
    : roundOre(roundOre(supplementBasis * supplementRate) * days)
  const combined = input.rounding === 'combined_daily'
    ? roundOre(roundOre(payBasis * dayRate + supplementBasis * supplementRate) * days)
    : roundOre(vacationPay + supplement)
  return { vacationPay, salaryDeduction, supplement, netAddition: roundOre(combined - salaryDeduction) }
}
