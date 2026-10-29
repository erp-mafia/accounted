import { equalOre, roundOre } from '@/lib/money'

/**
 * Prior years' tax losses of a juridisk person (underskott, IL 40 kap.) for
 * one beskattningsår, in öre. Pure: the register service feeds it a row and
 * what the rows before it say, and stores what it answers.
 *
 * The year on INK2S (SKV 2002, fields from official-ink2s-fields.json):
 *   4.14 a (7763) the whole deficit brought forward, spärrat or not;
 *   4.14 b (7671) the part cut off for good: beloppsspärr (40:15), an
 *          overriding tax reason (40:17 a), ackord or konkurs (40:20-21);
 *   4.14 c (7672) the part the koncernbidragsspärr keeps from this year's
 *          deduction (40:18); it is not lost and is also reported on 1.2;
 *   4.15 / 4.16 = the year's result before 4.14 less 4.14 a plus 4.14 b and c.
 * Carried to the next year (INK2 1.2) is the 4.16 underskott plus 4.14 c.
 *
 * Rules, read from IL 40 kap. as amended through SFS 2026:1393:
 *   - 40:2: the deficit remaining from the previous year is deducted in full.
 *   - 40:15: in the year a beloppsspärr enters, deficits from before that
 *     year that exceed 300 % of the utgift for the controlling interest are
 *     not deductible (the year's own deficit is outside the rule).
 *   - 40:16: that utgift is reduced by kapitaltillskott made before the
 *     change but not earlier than two beskattningsår before its year
 *     (except tillskott from a company in the same koncern before and after).
 *   - 40:18: while the koncernbidragsspärr lasts (the year it entered and the
 *     five following beskattningsår), deficits from before it are deducted at
 *     most up to the year's överskott computed without the deficit deduction
 *     and without koncernbidrag taxable under 35 kap. (40:19 lets koncernbidrag
 *     from companies already in the koncern before the change count); the
 *     beloppsspärr's cut is taken first.
 * Not modelled: the 24 kap. ränteavdrag limits the 40:18 ceiling is read
 * before, a government exemption (40:17), and the division across several
 * deficit companies in one koncern (40:15 last sentence). Those are entered
 * as manual reductions.
 */

/** IL 40 kap. 15 §: 300 % of the utgift. */
export const AMOUNT_BLOCK_MULTIPLIER = 3
/** IL 40 kap. 16 §: tillskott from at most two beskattningsår before the year of the change. */
export const CAPITAL_CONTRIBUTION_WINDOW_YEARS = 2
/** IL 40 kap. 18 §: the koncernbidragsspärr lasts through the fifth beskattningsår after the year it entered. */
export const GROUP_BLOCK_YEARS_AFTER_CHANGE = 5

export type LossYearWarningCode =
  /** A beloppsspärr applies but the utgift is missing: 4.14 b is not computed and nothing is cut. */
  | 'amount_block_missing_cost'
  /** A manual 4.14 b differs from the computed beloppsspärr. */
  | 'amount_block_manual_differs'
  /** The koncernbidragsspärr applies but the year's result is missing: 4.14 c is not computed. */
  | 'group_block_missing_result'
  /** The koncernbidragsspärr continues but the previous year is not in the register: 4.14 c is not computed. */
  | 'group_block_missing_pool'
  /** A manual 4.14 c differs from the computed koncernbidragsspärr. */
  | 'group_block_manual_differs'

export interface AmountBlockInput {
  /** Utgiften för att förvärva det bestämmande inflytandet (40:15); null while not entered. */
  acquisitionCost: number | null
  /** Kapitaltillskott that reduce the utgift (40:16). */
  capitalContributions: number
}

/**
 * The koncernbidragsspärr in this year: the year it entered (the whole
 * deficit brought forward, after the beloppsspärr, is spärrat) or a later
 * year inside its window (what the previous year's 4.14 c kept back; null
 * when that year is not in the register).
 */
export type GroupBlockInput = { kind: 'change_year' } | { kind: 'continuing'; pool: number | null }

export interface LossYearInput {
  /** INK2S 4.14 a: the deficit brought forward from the previous year. */
  broughtForward: number
  /** The year's result on INK2S before 4.14 (4.1 to 4.13); negative for a deficit, null while unknown. */
  resultBeforeDeficit: number | null
  /** Koncernbidrag in that result that 40:18 keeps out of the ceiling. */
  groupContributionsReceived: number
  /** Set in the year of an ownership change that triggers a beloppsspärr. */
  amountBlock: AmountBlockInput | null
  /** Set while a koncernbidragsspärr applies. */
  groupBlock: GroupBlockInput | null
  /** A 4.14 b the user states instead (40:17 a, ackord, konkurs, or a checked figure). */
  manualAmountBlockReduction?: number | null
  /** A 4.14 c the user states instead. */
  manualGroupBlockReduction?: number | null
}

export interface LossYearResult {
  broughtForward: number
  /** 300 % of the utgift less tillskott, when a beloppsspärr is computed. */
  amountBlockLimit: number | null
  computedAmountBlockReduction: number | null
  /** INK2S 4.14 b used: the manual figure when given, else the computed one, else 0. */
  amountBlockReduction: number
  computedGroupBlockReduction: number | null
  /** INK2S 4.14 c used: the manual figure when given, else the computed one, else 0. */
  groupBlockReduction: number
  /** What the year deducts: 4.14 a less 4.14 b and 4.14 c. The tax adjustments prefill this. */
  deductible: number
  /** INK2S 4.15 when positive, 4.16 when negative; null while the year's result is unknown. */
  taxableResult: number | null
  /** To the next year's 4.14 a (INK2 1.2: 4.16 plus 4.14 c); null while the year's result is unknown. */
  carriedForward: number | null
  warnings: LossYearWarningCode[]
}

/** 300 % of the utgift after the 40:16 reduction, never below zero. */
export function amountBlockLimit(acquisitionCost: number, capitalContributions: number): number {
  const basis = Math.max(0, roundOre(acquisitionCost - capitalContributions))
  return roundOre(basis * AMOUNT_BLOCK_MULTIPLIER)
}

/** The last fiscal year (by the calendar year it ends in) a koncernbidragsspärr entered in `changeYear` covers. */
export function defaultGroupBlockLastYear(changeYear: number): number {
  return changeYear + GROUP_BLOCK_YEARS_AFTER_CHANGE
}

function nonNegative(value: number): number {
  return Math.max(0, roundOre(value))
}

export function computeLossYear(input: LossYearInput): LossYearResult {
  const warnings: LossYearWarningCode[] = []
  const broughtForward = nonNegative(input.broughtForward)
  const result = input.resultBeforeDeficit === null ? null : roundOre(input.resultBeforeDeficit)

  // 4.14 b: the beloppsspärr cuts, for good, what exceeds 300 % of the utgift.
  let limit: number | null = null
  let computedB: number | null = null
  if (input.amountBlock) {
    if (input.amountBlock.acquisitionCost === null) {
      warnings.push('amount_block_missing_cost')
    } else {
      limit = amountBlockLimit(input.amountBlock.acquisitionCost, nonNegative(input.amountBlock.capitalContributions))
      computedB = nonNegative(broughtForward - limit)
    }
  }
  const manualB = input.manualAmountBlockReduction ?? null
  const amountBlockReduction =
    manualB !== null ? Math.min(broughtForward, nonNegative(manualB)) : computedB ?? 0
  if (manualB !== null && computedB !== null && !equalOre(amountBlockReduction, computedB)) {
    warnings.push('amount_block_manual_differs')
  }
  const usable = roundOre(broughtForward - amountBlockReduction)

  // 4.14 c: while the koncernbidragsspärr lasts, the spärrat deficit is
  // deducted only up to the year's överskott without koncernbidrag.
  let computedC: number | null = null
  if (input.groupBlock) {
    const pool =
      input.groupBlock.kind === 'change_year'
        ? usable
        : input.groupBlock.pool === null
          ? null
          : Math.min(usable, nonNegative(input.groupBlock.pool))
    if (pool === null) {
      warnings.push('group_block_missing_pool')
    } else if (result === null) {
      warnings.push('group_block_missing_result')
    } else {
      const ceiling = nonNegative(result - nonNegative(input.groupContributionsReceived))
      computedC = roundOre(pool - Math.min(pool, ceiling))
    }
  }
  const manualC = input.manualGroupBlockReduction ?? null
  const groupBlockReduction = manualC !== null ? Math.min(usable, nonNegative(manualC)) : computedC ?? 0
  if (manualC !== null && computedC !== null && !equalOre(groupBlockReduction, computedC)) {
    warnings.push('group_block_manual_differs')
  }

  const deductible = roundOre(usable - groupBlockReduction)
  const taxableResult = result === null ? null : roundOre(result - deductible)
  const carriedForward =
    taxableResult === null ? null : roundOre(Math.max(0, -taxableResult) + groupBlockReduction)

  return {
    broughtForward,
    amountBlockLimit: limit,
    computedAmountBlockReduction: computedB,
    amountBlockReduction,
    computedGroupBlockReduction: computedC,
    groupBlockReduction,
    deductible,
    taxableResult,
    carriedForward,
    warnings,
  }
}
