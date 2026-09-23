import type { PayrollConfig } from './payroll-config'

/**
 * Swedish benefit value calculations (förmånsbeskattning).
 * Implements Skatteverket's rules for taxable benefits.
 */

export interface BenefitStep {
  label: string
  formula: string
  input: Record<string, number | string>
  output: number
}

// ============================================================
// Car Benefit (Bilförmån): Generation 3 (≥July 1, 2021)
// ============================================================

export interface CarBenefitParams {
  nybilspris: number        // New car price including options
  fordonsskatt: number      // Annual vehicle tax
  isEnvironmental: boolean  // Elbil/laddhybrid/gasbil
  environmentalType?: 'electric' | 'plugin_hybrid' | 'gas'
  highMileage: boolean      // ≥30,000 km/year (25% reduction)
}

/**
 * Calculate monthly car benefit value (förmånsvärde bilförmån).
 *
 * Gen3 formula (≥July 2021):
 * annual = 0.29 × PBB + nybilspris × (0.70 × SLR + 0.01) + 0.13 × nybilspris + fordonsskatt
 *
 * Environmental reductions on nybilspris:
 * - Elbil/vätgas: -350,000 (max 50% of nybilspris)
 * - Laddhybrid: -140,000 (max 50%)
 * - Gasbil: -100,000 (max 50%)
 *
 * High mileage (≥30,000 km/year): 25% reduction on total
 */
export function calculateCarBenefit(
  params: CarBenefitParams,
  config: PayrollConfig
): { monthlyValue: number; annualValue: number; steps: BenefitStep[] } {
  const r = (x: number) => Math.round(x * 100) / 100
  const steps: BenefitStep[] = []

  let adjustedPrice = params.nybilspris

  // Environmental reduction
  if (params.isEnvironmental && params.environmentalType) {
    const reductions: Record<string, number> = {
      electric: 350000,
      plugin_hybrid: 140000,
      gas: 100000,
    }
    const maxReduction = Math.min(reductions[params.environmentalType] || 0, params.nybilspris * 0.5)
    adjustedPrice = params.nybilspris - maxReduction
    steps.push({
      label: `Miljöbilsreduktion (${params.environmentalType})`,
      formula: 'nybilspris - reduction (max 50%)',
      input: { nybilspris: params.nybilspris, reduction: maxReduction },
      output: adjustedPrice,
    })
  }

  const pbbComponent = r(0.29 * config.prisbasbelopp)
  const rateComponent = r(adjustedPrice * (0.70 * config.bilformanSlr + 0.01))
  const percentComponent = r(0.13 * adjustedPrice)
  const annualValue = r(pbbComponent + rateComponent + percentComponent + params.fordonsskatt)

  steps.push({
    label: 'Bilförmån (Gen3)',
    formula: '0.29×PBB + pris×(0.70×SLR+0.01) + 0.13×pris + fordonsskatt',
    input: {
      pbb: config.prisbasbelopp,
      slr: config.bilformanSlr,
      adjusted_price: adjustedPrice,
      fordonsskatt: params.fordonsskatt,
    },
    output: annualValue,
  })

  let finalAnnual = annualValue
  if (params.highMileage) {
    finalAnnual = r(annualValue * 0.75)
    steps.push({
      label: 'Milreduktion (≥30 000 km/år)',
      formula: 'annual × 75%',
      input: { annual: annualValue },
      output: finalAnnual,
    })
  }

  const monthlyValue = r(finalAnnual / 12)
  steps.push({
    label: 'Månatligt förmånsvärde',
    formula: 'annual / 12',
    input: { annual: finalAnnual },
    output: monthlyValue,
  })

  return { monthlyValue, annualValue: finalAnnual, steps }
}

// ============================================================
// Meal Benefit (Kostförmån)
// ============================================================

export type MealType = 'full_day' | 'lunch' | 'breakfast'

/**
 * Get meal benefit value (schablonvärde).
 * If employee pays ≥ schablonvärde via nettolöneavdrag, benefit is eliminated.
 */
export function getMealBenefitValue(mealType: MealType, config: PayrollConfig): number {
  switch (mealType) {
    case 'full_day': return config.kostformanHeldag
    case 'lunch': return config.kostformanLunch
    case 'breakfast': return config.kostformanFrukost
  }
}

// ============================================================
// Bike Benefit (Cykelförmån)
// ============================================================

/**
 * Annual tax-free allowance for cykelförmån, in SEK.
 * Per Skatteverket schablon effective from 2022: the first 3 000 kr/year of
 * a bike benefit is tax-free; the excess is taxable. The employer must offer
 * the benefit on equal terms to all employees.
 */
export const BIKE_BENEFIT_TAX_FREE_ALLOWANCE = 3000

/**
 * Calculate monthly taxable cykelförmån from an annual market value.
 *
 * taxable_annual  = max(0, annual_market_value - 3000)
 * taxable_monthly = taxable_annual / 12
 *
 * `annualMarketValue` is the yearly värde av förmånen, typically the
 * marknadsmässiga hyran or the subscription cost the employer pays.
 */
export function calculateBikeBenefit(annualMarketValue: number): {
  monthlyValue: number
  annualTaxable: number
  taxFreePortion: number
  steps: BenefitStep[]
} {
  const r = (x: number) => Math.round(x * 100) / 100
  const annual = Math.max(0, annualMarketValue)
  const taxFreePortion = Math.min(annual, BIKE_BENEFIT_TAX_FREE_ALLOWANCE)
  const annualTaxable = r(annual - taxFreePortion)
  const monthlyValue = r(annualTaxable / 12)

  return {
    monthlyValue,
    annualTaxable,
    taxFreePortion,
    steps: [{
      label: 'Cykelförmån (schablon)',
      formula: 'max(0, årligt marknadsvärde − 3 000 kr skattefritt) / 12',
      input: {
        annual_market_value: annual,
        tax_free_allowance: BIKE_BENEFIT_TAX_FREE_ALLOWANCE,
        annual_taxable: annualTaxable,
      },
      output: monthlyValue,
    }],
  }
}

// ============================================================
// Wellness Benefit (Friskvårdsbidrag)
// ============================================================

/**
 * Check wellness benefit tax status.
 * Tax-free if total ≤ cap (5,000 SEK/year).
 * If exceeded, ENTIRE amount becomes taxable (not just excess).
 */
export function calculateWellnessBenefit(
  amount: number,
  ytdWellness: number,
  config: PayrollConfig
): { taxable: boolean; taxableAmount: number; steps: BenefitStep[] } {
  const totalYtd = ytdWellness + amount
  const taxable = totalYtd > config.friskvardCap

  return {
    taxable,
    taxableAmount: taxable ? totalYtd : 0, // Entire amount if exceeded
    steps: [{
      label: 'Friskvårdsbidrag',
      formula: taxable
        ? `YTD ${totalYtd} > ${config.friskvardCap}: hela beloppet skattepliktigt`
        : `YTD ${totalYtd} ≤ ${config.friskvardCap}: skattefritt`,
      input: { amount, ytd: ytdWellness, cap: config.friskvardCap },
      output: taxable ? totalYtd : 0,
    }],
  }
}
