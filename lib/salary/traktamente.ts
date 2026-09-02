import type { PayrollConfig } from './payroll-config'
import type { MileageVehicleType } from '@/types'

/**
 * Traktamente (per diem) and milersättning (mileage) calculations.
 * Implements Skatteverket's schablonbelopp and tremånadersregeln.
 */

export interface TraktamenteStep {
  label: string
  formula: string
  input: Record<string, number | string>
  output: number
}

export type TripType = 'full_day' | 'half_day' | 'night'
export type MealsProvided = 'none' | 'breakfast' | 'lunch' | 'dinner' | 'lunch_dinner' | 'all'

/**
 * Calculate traktamente for a domestic trip.
 *
 * Tax-free schabloner 2026:
 * - Full day (>24h): 300 SEK
 * - Half day (>6h): 150 SEK
 * - Night: 150 SEK
 *
 * Tremånadersregeln:
 * - After 3 consecutive months at same location: 70% of max
 * - After 2 years: 50% of max
 * - Break ≥4 weeks resets counter
 */
export function calculateTraktamente(params: {
  tripType: TripType
  days: number
  mealsProvided: MealsProvided
  consecutiveMonths: number // 0 = no reduction
  config: PayrollConfig
}): { taxFree: number; taxable: number; totalPaid: number; steps: TraktamenteStep[] } {
  const r = (x: number) => Math.round(x * 100) / 100
  const steps: TraktamenteStep[] = []

  // Base rate
  let baseRate: number
  switch (params.tripType) {
    case 'full_day': baseRate = params.config.traktamenteHeldag; break
    case 'half_day': baseRate = params.config.traktamenteHalvdag; break
    case 'night': baseRate = params.config.traktamenteNatt; break
  }

  // Tremånadersregeln reduction
  let reductionFactor = 1.0
  if (params.consecutiveMonths >= 24) {
    reductionFactor = 0.50
  } else if (params.consecutiveMonths >= 3) {
    reductionFactor = 0.70
  }

  const maxTaxFreePerDay = r(baseRate * reductionFactor)

  if (reductionFactor < 1.0) {
    steps.push({
      label: `Tremånadersregeln (${params.consecutiveMonths} mån)`,
      formula: `base × ${reductionFactor * 100}%`,
      input: { base_rate: baseRate, months: params.consecutiveMonths },
      output: maxTaxFreePerDay,
    })
  }

  // Meal reductions per Skatteverket (from max tax-free amount)
  // Breakfast: 15%, Lunch: 35%, Dinner: 35%, All three: 85%
  let mealReduction = 0
  if (params.tripType === 'full_day') {
    switch (params.mealsProvided) {
      case 'breakfast': mealReduction = r(baseRate * 0.15); break
      case 'lunch': case 'dinner': mealReduction = r(baseRate * 0.35); break
      case 'lunch_dinner': mealReduction = r(baseRate * 0.70); break
      case 'all': mealReduction = r(baseRate * 0.85); break
    }
  }

  const taxFreePerDay = r(Math.max(maxTaxFreePerDay - mealReduction, 0))
  const taxFree = r(taxFreePerDay * params.days)

  steps.push({
    label: 'Skattefritt traktamente',
    formula: '(max_tax_free - meal_reduction) × days',
    input: {
      max_per_day: maxTaxFreePerDay,
      meal_reduction: mealReduction,
      days: params.days,
    },
    output: taxFree,
  })

  // If employer pays more than tax-free amount, excess is taxable
  const totalPaid = r(baseRate * params.days) // Employer typically pays full rate
  const taxable = r(Math.max(totalPaid - taxFree, 0))

  if (taxable > 0) {
    steps.push({
      label: 'Skattepliktigt traktamente',
      formula: 'total_paid - tax_free',
      input: { total_paid: totalPaid, tax_free: taxFree },
      output: taxable,
    })
  }

  return { taxFree, taxable, totalPaid, steps }
}

// ============================================================
// Milersättning (Mileage Allowance)
// ============================================================

export type VehicleType = MileageVehicleType

/**
 * Calculate milersättning.
 *
 * Tax-free rates (2024-2026, unchanged):
 * - Own car: 25 SEK/mil (2.50 SEK/km)
 * - Company car (fossil): 12 SEK/mil
 * - Company car (electric/hybrid): 9.50 SEK/mil
 *
 * Amount exceeding tax-free = taxable + full avgifter.
 * Requires körjournal (7-year retention).
 */
export function calculateMileageAllowance(params: {
  mil: number // Swedish mil (1 mil = 10 km)
  vehicleType: VehicleType
  paidPerMil: number // What employer actually pays per mil
  config: PayrollConfig
}): { taxFree: number; taxable: number; steps: TraktamenteStep[] } {
  const r = (x: number) => Math.round(x * 100) / 100

  let taxFreeRate: number
  switch (params.vehicleType) {
    case 'own_car': taxFreeRate = params.config.milersattningEgenBil; break
    case 'company_car_fossil': taxFreeRate = params.config.milersattningFormansbilFossil; break
    case 'company_car_electric': taxFreeRate = params.config.milersattningFormansbilEl; break
  }

  const taxFree = r(Math.min(params.paidPerMil, taxFreeRate) * params.mil)
  const totalPaid = r(params.paidPerMil * params.mil)
  const taxable = r(Math.max(totalPaid - taxFree, 0))

  return {
    taxFree,
    taxable,
    steps: [{
      label: 'Milersättning',
      formula: `${params.mil} mil × ${params.paidPerMil} SEK/mil (skattefritt max ${taxFreeRate})`,
      input: {
        mil: params.mil,
        paid_per_mil: params.paidPerMil,
        tax_free_rate: taxFreeRate,
      },
      output: totalPaid,
    }],
  }
}
