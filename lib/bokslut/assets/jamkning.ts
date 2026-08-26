/**
 * Pure helpers for adjustment of input VAT on investment goods under
 * Mervardesskattelagen (2023:200), chapter 15.
 *
 * The acquisition year and disposal year both count in the adjustment
 * period. The basis is total original input VAT, not only the amount that was
 * deducted at acquisition.
 */

import type { AssetCategory, VatTreatment } from '@/types'

export type JamkningDirection = 'increase' | 'decrease' | 'none' | 'transferred'

export interface JamkningAssessmentInput {
  acquisitionDate: string
  disposalDate: string
  category?: AssetCategory
  basAssetAccount?: string
  originalInputVat: number
  originalDeductionPercent: number
  disposalType: 'sale' | 'scrap' | 'business_transfer'
  vatTreatment?: VatTreatment
  netProceeds?: number
}

export interface JamkningAssessment {
  isInvestmentGood: boolean
  threshold: number
  totalYears: number
  remainingYears: number
  originalDeductionPercent: number
  newDeductionPercent: number | null
  direction: JamkningDirection
  amount: number
  capped: boolean
  reason:
    | 'below_threshold'
    | 'outside_adjustment_period'
    | 'scrap'
    | 'transferred'
    | 'change_below_five_points'
    | 'adjustment'
}

/**
 * Assess a disposal using the one-time adjustment formula in ML 15:13-18.
 * A taxable sale of movable property is capped at 25 percent of net proceeds.
 */
export function assessJamkning(input: JamkningAssessmentInput): JamkningAssessment {
  const realProperty = isRealProperty(input)
  const totalYears = realProperty ? 10 : 5
  const threshold = realProperty ? 100_000 : 50_000
  const remainingYears = yearsRemaining(
    input.acquisitionDate,
    input.disposalDate,
    totalYears,
  )
  const originalDeductionPercent = clampPercent(input.originalDeductionPercent)
  const base = {
    isInvestmentGood: input.originalInputVat >= threshold,
    threshold,
    totalYears,
    remainingYears,
    originalDeductionPercent,
  }

  if (!base.isInvestmentGood) {
    return noAdjustment(base, 'below_threshold', originalDeductionPercent)
  }
  if (remainingYears === 0) {
    return noAdjustment(base, 'outside_adjustment_period', originalDeductionPercent)
  }
  if (input.disposalType === 'scrap') {
    return noAdjustment(base, 'scrap', originalDeductionPercent)
  }
  if (input.disposalType === 'business_transfer') {
    return {
      ...base,
      newDeductionPercent: null,
      direction: 'transferred',
      amount: 0,
      capped: false,
      reason: 'transferred',
    }
  }

  const newDeductionPercent = treatmentRetainsDeduction(input.vatTreatment) ? 100 : 0
  const change = newDeductionPercent - originalDeductionPercent
  if (Math.abs(change) < 5) {
    return noAdjustment(base, 'change_below_five_points', newDeductionPercent)
  }

  const rawAmount = round2(
    input.originalInputVat * (Math.abs(change) / 100) * (remainingYears / totalYears),
  )
  let amount = rawAmount
  let capped = false

  if (!realProperty && change > 0 && treatmentRetainsDeduction(input.vatTreatment)) {
    const cap = round2(Math.max(0, Number(input.netProceeds ?? 0)) * 0.25)
    if (amount > cap) {
      amount = cap
      capped = true
    }
  }

  return {
    ...base,
    newDeductionPercent,
    direction: change > 0 ? 'increase' : 'decrease',
    amount,
    capped,
    reason: 'adjustment',
  }
}

export interface JamkningEligibility {
  totalYears: number
  elapsedYears: number
  remainingYears: number
  withinAdjustmentPeriod: boolean
  threshold: number
}

export function assessJamkningEligibility(args: {
  basAssetAccount?: string
  category?: AssetCategory
  acquisitionDate: string
  disposalDate: string
}): JamkningEligibility {
  const realProperty = isRealProperty(args)
  const totalYears = realProperty ? 10 : 5
  const acquisitionYear = isoYear(args.acquisitionDate)
  const disposalYear = isoYear(args.disposalDate)
  const elapsedYears = Math.max(0, disposalYear - acquisitionYear)
  const remainingYears = yearsRemaining(args.acquisitionDate, args.disposalDate, totalYears)

  return {
    totalYears,
    elapsedYears,
    remainingYears,
    withinAdjustmentPeriod: remainingYears > 0,
    threshold: realProperty ? 100_000 : 50_000,
  }
}

function noAdjustment(
  base: Pick<
    JamkningAssessment,
    | 'isInvestmentGood'
    | 'threshold'
    | 'totalYears'
    | 'remainingYears'
    | 'originalDeductionPercent'
  >,
  reason: Exclude<JamkningAssessment['reason'], 'transferred' | 'adjustment'>,
  newDeductionPercent: number,
): JamkningAssessment {
  return {
    ...base,
    newDeductionPercent,
    direction: 'none',
    amount: 0,
    capped: false,
    reason,
  }
}

function treatmentRetainsDeduction(treatment: VatTreatment | undefined): boolean {
  return treatment !== undefined && treatment !== 'exempt'
}

function isRealProperty(args: {
  basAssetAccount?: string
  category?: AssetCategory
}): boolean {
  if (args.basAssetAccount && /^11\d{2}$/.test(args.basAssetAccount)) return true
  return args.category === 'building' || args.category === 'land_improvement'
}

function yearsRemaining(acquisitionDate: string, disposalDate: string, totalYears: number): number {
  const acquisitionYear = isoYear(acquisitionDate)
  const disposalYear = isoYear(disposalDate)
  return Math.max(0, Math.min(totalYears, totalYears - (disposalYear - acquisitionYear)))
}

function isoYear(value: string): number {
  const match = /^(\d{4})-\d{2}-\d{2}$/.exec(value)
  return match ? Number(match[1]) : 0
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value))
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}
