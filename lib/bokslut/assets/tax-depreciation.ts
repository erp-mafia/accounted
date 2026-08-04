import type { AssetCategory } from '@/types'
import { roundOre } from '@/lib/money'

export type TaxDepreciationMethod = 'rakenskapsenlig' | 'restvarde'
export type TaxDepreciationRule = 'huvudregel_30' | 'kompletteringsregel_20'

export const TAX_DEPRECIATION_CATEGORIES: readonly AssetCategory[] = [
  'machinery',
  'equipment',
  'vehicle',
  'computer',
] as const

export interface TaxDepreciationCohort {
  label: string
  acquisitionCost: number
  /**
   * Sum of the fiscal-period lengths from the acquisition period through the
   * current period. The 20 percent rule applies a full period's adjusted rate
   * regardless of the acquisition date inside that period.
   */
  elapsedMonths: number
}

export interface TaxDepreciationInput {
  method: TaxDepreciationMethod
  selectedRule?: TaxDepreciationRule
  openingTaxValue: number
  additions: number
  disposals: number
  periodMonths: number
  cohorts: TaxDepreciationCohort[]
  /** Actual deduction elected for the period. Omit when calculating the
   *  statutory maximum before the user has reconciled the election. */
  electedDeduction?: number
}

export interface TaxDepreciationAlternative {
  rule: TaxDepreciationRule | 'restvarde_25'
  rate: number | null
  deduction: number
  closingTaxValue: number
}

export interface TaxDepreciationResult {
  method: TaxDepreciationMethod
  selectedRule: TaxDepreciationRule | null
  openingTaxValue: number
  additions: number
  disposals: number
  basis: number
  periodMonths: number
  maximumDeduction: number
  deduction: number
  closingTaxValue: number
  excessDisposals: number
  alternatives: TaxDepreciationAlternative[]
  cohorts: Array<TaxDepreciationCohort & { remainingRate: number; closingValue: number }>
}

/**
 * Calculate the annual tax value for the pooled machinery and inventory
 * population under IL 18 kap. This is deliberately separate from ordinary
 * per-asset depreciation: the 30, 20 and 25 percent rules are tax valuation
 * rules for a pool, not book-depreciation methods on an individual asset.
 */
export function computeTaxDepreciation(input: TaxDepreciationInput): TaxDepreciationResult {
  assertNonNegative('openingTaxValue', input.openingTaxValue)
  assertNonNegative('additions', input.additions)
  assertNonNegative('disposals', input.disposals)
  if (!Number.isInteger(input.periodMonths) || input.periodMonths < 1 || input.periodMonths > 18) {
    throw new Error('periodMonths must be an integer between 1 and 18')
  }

  const openingTaxValue = roundOre(input.openingTaxValue)
  const additions = roundOre(input.additions)
  const disposals = roundOre(input.disposals)
  const grossBasis = roundOre(openingTaxValue + additions)
  const basis = roundOre(Math.max(0, grossBasis - disposals))
  const excessDisposals = roundOre(Math.max(0, disposals - grossBasis))

  const cohorts = input.cohorts.map((cohort) => {
    assertNonNegative('cohort acquisitionCost', cohort.acquisitionCost)
    if (!Number.isInteger(cohort.elapsedMonths) || cohort.elapsedMonths < 1) {
      throw new Error('cohort elapsedMonths must be a positive integer')
    }
    const remainingRate = clampRate(1 - 0.2 * (cohort.elapsedMonths / 12))
    return {
      ...cohort,
      acquisitionCost: roundOre(cohort.acquisitionCost),
      remainingRate,
      closingValue: roundOre(cohort.acquisitionCost * remainingRate),
    }
  })

  if (input.method === 'restvarde') {
    if (input.selectedRule !== undefined) {
      throw new Error('selectedRule is only valid for rakenskapsenlig depreciation')
    }
    const rate = 0.25 * (input.periodMonths / 12)
    const maximumDeduction = roundOre(Math.min(basis, basis * rate))
    const deduction = resolveElectedDeduction(input.electedDeduction, maximumDeduction)
    const closingTaxValue = roundOre(basis - deduction)
    return {
      method: input.method,
      selectedRule: null,
      openingTaxValue,
      additions,
      disposals,
      basis,
      periodMonths: input.periodMonths,
      maximumDeduction,
      deduction,
      closingTaxValue,
      excessDisposals,
      alternatives: [{
        rule: 'restvarde_25',
        rate,
        deduction: maximumDeduction,
        closingTaxValue: roundOre(basis - maximumDeduction),
      }],
      cohorts,
    }
  }

  if (!input.selectedRule) {
    throw new Error('selectedRule is required for rakenskapsenlig depreciation')
  }

  // IL 18 kap. 17 §: the 20-rule's lowest permitted closing value is derived
  // from acquisition-year cohorts. With a positive basis but no cohort at all,
  // the reduce degenerates to a full write-off, which is not a computation the
  // cohort evidence supports; refuse instead of silently deducting everything.
  if (input.selectedRule === 'kompletteringsregel_20' && cohorts.length === 0 && basis > 0) {
    throw new Error(
      'kompletteringsregel_20 requires at least one acquisition cohort for a non-zero basis',
    )
  }

  const mainRate = 0.3 * (input.periodMonths / 12)
  const mainDeduction = roundOre(Math.min(basis, basis * mainRate))
  const mainClosing = roundOre(basis - mainDeduction)
  const complementaryMinimum = roundOre(
    cohorts.reduce((sum, cohort) => sum + cohort.closingValue, 0),
  )
  const complementaryClosing = roundOre(Math.min(basis, complementaryMinimum))
  const complementaryDeduction = roundOre(basis - complementaryClosing)

  const alternatives: TaxDepreciationAlternative[] = [
    {
      rule: 'huvudregel_30',
      rate: mainRate,
      deduction: mainDeduction,
      closingTaxValue: mainClosing,
    },
    {
      rule: 'kompletteringsregel_20',
      rate: null,
      deduction: complementaryDeduction,
      closingTaxValue: complementaryClosing,
    },
  ]
  const selected = alternatives.find((alternative) => alternative.rule === input.selectedRule)
  if (!selected) throw new Error('Unsupported tax depreciation rule')
  const deduction = resolveElectedDeduction(input.electedDeduction, selected.deduction)

  return {
    method: input.method,
    selectedRule: input.selectedRule,
    openingTaxValue,
    additions,
    disposals,
    basis,
    periodMonths: input.periodMonths,
    maximumDeduction: selected.deduction,
    deduction,
    closingTaxValue: roundOre(basis - deduction),
    excessDisposals,
    alternatives,
    cohorts,
  }
}

export function fiscalPeriodMonths(periodStart: string, periodEnd: string): number {
  const start = parseIsoDate(periodStart)
  const end = parseIsoDate(periodEnd)
  if (end < start) throw new Error('Fiscal period end must not precede its start')
  return (
    (end.getUTCFullYear() - start.getUTCFullYear()) * 12
    + end.getUTCMonth()
    - start.getUTCMonth()
    + 1
  )
}

function parseIsoDate(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`Invalid ISO date: ${value}`)
  const date = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid ISO date: ${value}`)
  return date
}

function assertNonNegative(label: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be non-negative`)
}

function clampRate(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function resolveElectedDeduction(value: number | undefined, maximumDeduction: number): number {
  if (value === undefined) return maximumDeduction
  assertNonNegative('electedDeduction', value)
  const deduction = roundOre(value)
  if (deduction > maximumDeduction) {
    throw new Error('electedDeduction must not exceed the statutory maximum')
  }
  return deduction
}
