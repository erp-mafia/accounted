import type { PayrollConfig } from './payroll-config'

/**
 * Löneväxling till pension: salary sacrifice to occupational pension.
 *
 * The 1.058 factor: For every 1 SEK salary reduction, pension contribution
 * should be 1.058 SEK to make the employee roughly cost-neutral
 * (because reduced salary → reduced avgifter for employer).
 *
 * Warnings:
 * - Post-reduction salary < 8.07 × IBB / 12 reduces PGI and SGI
 * - Employer pension cap: 35% of pensionsmedförande lön or 10 × PBB/year
 */

export interface LoneVaxlingResult {
  salaryReduction: number
  pensionContribution: number
  preReductionSalary: number
  postReductionSalary: number
  savedAvgifter: number
  slpOnPension: number
  netEmployerSaving: number
  warnings: string[]
  steps: LoneVaxlingStep[]
}

export interface LoneVaxlingStep {
  label: string
  formula: string
  input: Record<string, number | string>
  output: number
}

/**
 * Calculate löneväxling impact.
 *
 * @param reductionAmount - Monthly bruttolöneavdrag amount
 * @param currentMonthlySalary - Current gross monthly salary before reduction
 * @param config - Payroll config for the year
 * @param avgifterRate - Employee's applicable avgifter rate (may differ from standard)
 */
export function calculateLoneVaxling(
  reductionAmount: number,
  currentMonthlySalary: number,
  config: PayrollConfig,
  avgifterRate: number = 0.3142
): LoneVaxlingResult {
  const r = (x: number) => Math.round(x * 100) / 100
  const steps: LoneVaxlingStep[] = []
  const warnings: string[] = []

  const factor = 1.058
  const pensionContribution = r(reductionAmount * factor)
  steps.push({
    label: 'Pensionsavsättning',
    formula: 'reduction × 1.058',
    input: { reduction: reductionAmount, factor },
    output: pensionContribution,
  })

  const postReductionSalary = r(currentMonthlySalary - reductionAmount)
  steps.push({
    label: 'Ny bruttolön',
    formula: 'current - reduction',
    input: { current: currentMonthlySalary, reduction: reductionAmount },
    output: postReductionSalary,
  })

  // Avgifter savings
  const savedAvgifter = r(reductionAmount * avgifterRate)
  steps.push({
    label: 'Sparade arbetsgivaravgifter',
    formula: 'reduction × avgifter_rate',
    input: { reduction: reductionAmount, avgifter_rate: avgifterRate },
    output: savedAvgifter,
  })

  // SLP (Särskild löneskatt) on pension: 24.26%
  const slpOnPension = r(pensionContribution * config.slpRate)
  steps.push({
    label: 'Särskild löneskatt på pension',
    formula: 'pension × SLP_rate',
    input: { pension: pensionContribution, slp_rate: config.slpRate },
    output: slpOnPension,
  })

  // Net employer cost difference
  const netEmployerSaving = r(savedAvgifter - pensionContribution - slpOnPension + reductionAmount)
  steps.push({
    label: 'Nettoresultat arbetsgivare',
    formula: 'saved_avgifter - pension - slp + reduction',
    input: { saved_avgifter: savedAvgifter, pension: pensionContribution, slp: slpOnPension, reduction: reductionAmount },
    output: netEmployerSaving,
  })

  // Warning: PGI/SGI floor
  const pgiFloor = r(8.07 * config.inkomstbasbelopp / 12)
  if (postReductionSalary < pgiFloor) {
    warnings.push(
      `Varning: Ny lön ${r(postReductionSalary)} SEK < PGI-golv ${r(pgiFloor)} SEK/mån. ` +
      `Reducerad allmän pension och sjukpenninggrundande inkomst (SGI).`
    )
  }

  // Warning: Pension cap
  const annualPensionCap = r(10 * config.prisbasbelopp)
  const annualContribution = r(pensionContribution * 12)
  if (annualContribution > annualPensionCap) {
    warnings.push(
      `Varning: Årsvis pensionsavsättning ${r(annualContribution)} SEK överstiger taket ${r(annualPensionCap)} SEK (10 × PBB).`
    )
  }

  return {
    salaryReduction: reductionAmount,
    pensionContribution,
    preReductionSalary: currentMonthlySalary,
    postReductionSalary,
    savedAvgifter,
    slpOnPension,
    netEmployerSaving,
    warnings,
    steps,
  }
}
