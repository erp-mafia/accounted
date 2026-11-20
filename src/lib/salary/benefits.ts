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
