/**
 * The verifikat of a semesterlöneskuld remeasurement, from a valuation, the
 * booked specification per employee and the booked balances: pure, so the
 * client can render the same lines (vacation-liability-remeasure.ts reads
 * the inputs and posts). The posting model is described there.
 */

import { roundOre, sumOre } from '@/lib/money'
import { coerceDimensionsBag, dimensionsBagKey, type LineDimensions } from '@/lib/bookkeeping/dimension-resolver'
import { creditNatural, debitNatural } from '@/lib/bookkeeping/line-side'
import type { CreateJournalEntryLineInput } from '@/types'
import { SALARY_ACCOUNTS, vacationLiabilityChangeAccount, type VacationLiabilityChangeAccount } from './account-mapping'
import type { VacationLiabilityEmployeeValue, VacationLiabilityValuation } from './vacation-liability-valuation'
import type { VacationLiabilityDays } from './vacation-liability-days'

/** Book an adjustment only beyond this (öre noise is no verifikat); the semesterårsavslut uses the same. */
export const DRIFT_TOLERANCE_SEK = 1

/** Where a change books for nobody in particular: the tjänsteman account, as splitVacationLiabilityChange falls back. */
const DEFAULT_CHANGE_ACCOUNT = vacationLiabilityChangeAccount({ employmentType: 'employee', personnelCategory: null })

/** Line texts: the user's words on the verifikat (stored data stays Swedish). */
export const REMEASURE_LINE_TEXT = 'Semesterlöneskuld, förändring'
export const REMEASURE_AVGIFTER_LINE_TEXT = 'Sociala avgifter på semesterlöneskuld, förändring'

export interface RemeasurePlanRow {
  employee_id: string
  employee_name: string
  account: VacationLiabilityChangeAccount
  dimensions: LineDimensions | null
  days: VacationLiabilityDays | null
  day_value_sek: number
  variable_vacation_pay_sek: number
  avgifter_rate: number
  computed_liability_sek: number
  computed_avgifter_sek: number
  /** The employee's share of 2920/2940 before the remeasurement. */
  booked_liability_sek: number
  booked_avgifter_sek: number
  /** What the verifikat moves for this employee (difference plus share of the unexplained rest). */
  adjustment_2920: number
  adjustment_2940: number
}

export interface RemeasurePlan {
  as_of_date: string
  basis: string
  day_value_policy: string
  settlement_year: number
  /** 2920/2940 as booked on the date (a run's own vouchers left out). */
  booked_2920: number
  booked_2940: number
  computed_liability: number
  computed_avgifter: number
  /** Computed minus booked: what the remeasurement moves. */
  difference_2920: number
  difference_2940: number
  rows: RemeasurePlanRow[]
  /** The verifikat's lines; empty when nothing beyond 1 krona would move. */
  lines: CreateJournalEntryLineInput[]
}

/**
 * Split `total` (öre) over `weights`, each part rounded to öre and the
 * largest weight absorbing the rounding, so the parts sum to `total`
 * exactly. Without a positive weight it splits evenly.
 */
function allocate(total: number, weights: number[]): number[] {
  if (weights.length === 0 || roundOre(total) === 0) return weights.map(() => 0)
  const positive = weights.map((w) => Math.max(0, w))
  const base = positive.some((w) => w > 0) ? positive : weights.map(() => 1)
  const sum = base.reduce((s, w) => s + w, 0)
  const parts = base.map((w) => roundOre((total * w) / sum))
  let largest = 0
  base.forEach((w, i) => {
    if (w > base[largest]) largest = i
  })
  parts[largest] = roundOre(parts[largest] + total - sumOre(parts))
  return parts
}

interface SpecRow {
  employeeId: string
  employeeName: string
  accruedAmount: number
  accruedAvgifter: number
  liabilityChangeAccount: VacationLiabilityChangeAccount
}

/**
 * The plan from a valuation, the booked specification per employee and the
 * booked balances. Pure.
 */
export function buildRemeasurePlan(
  valuation: VacationLiabilityValuation,
  spec: readonly SpecRow[],
  booked: { booked2920: number; booked2940: number },
): RemeasurePlan {
  const valueById = new Map(valuation.rows.map((row) => [row.employee_id, row]))
  const specById = new Map(spec.map((row) => [row.employeeId, row]))
  const ids = [...new Set([...valuation.rows.map((r) => r.employee_id), ...spec.map((r) => r.employeeId)])]

  const base = ids.map((id) => {
    const value: VacationLiabilityEmployeeValue | undefined = valueById.get(id)
    const own = specById.get(id)
    return {
      id,
      value,
      own,
      computed: value?.computed_liability_sek ?? 0,
      computedAvgifter: value?.computed_avgifter_sek ?? 0,
      booked: roundOre(own?.accruedAmount ?? 0),
      bookedAvgifter: roundOre(own?.accruedAvgifter ?? 0),
    }
  })

  const computedLiability = sumOre(base.map((b) => b.computed))
  const computedAvgifter = sumOre(base.map((b) => b.computedAvgifter))
  const difference2920 = roundOre(computedLiability - booked.booked2920)
  const difference2940 = roundOre(computedAvgifter - booked.booked2940)
  // What the ledger holds beyond (or short of) the employees' shares.
  const rest2920 = roundOre(difference2920 - sumOre(base.map((b) => roundOre(b.computed - b.booked))))
  const rest2940 = roundOre(difference2940 - sumOre(base.map((b) => roundOre(b.computedAvgifter - b.bookedAvgifter))))
  const restParts2920 = allocate(rest2920, base.map((b) => b.computed))
  const restParts2940 = allocate(rest2940, base.map((b) => b.computedAvgifter))

  const rows: RemeasurePlanRow[] = base.map((b, i) => ({
    employee_id: b.id,
    employee_name: b.value?.employee_name ?? b.own?.employeeName ?? '',
    account: b.value?.liability_change_account ?? b.own?.liabilityChangeAccount ?? DEFAULT_CHANGE_ACCOUNT,
    dimensions: coerceDimensionsBag(b.value?.default_dimensions) ?? null,
    days: b.value?.days ?? null,
    day_value_sek: b.value?.day_value_sek ?? 0,
    variable_vacation_pay_sek: b.value?.variable_vacation_pay_sek ?? 0,
    avgifter_rate: b.value?.avgifter_rate ?? 0,
    computed_liability_sek: b.computed,
    computed_avgifter_sek: b.computedAvgifter,
    booked_liability_sek: b.booked,
    booked_avgifter_sek: b.bookedAvgifter,
    adjustment_2920: roundOre(b.computed - b.booked + (restParts2920[i] ?? 0)),
    adjustment_2940: roundOre(b.computedAvgifter - b.bookedAvgifter + (restParts2940[i] ?? 0)),
  }))

  // No employee to carry a rest (a liability with nobody behind it): it
  // books on 7290 without dimensions.
  const orphan2920 = rows.length === 0 ? difference2920 : 0
  const orphan2940 = rows.length === 0 ? difference2940 : 0

  return {
    as_of_date: valuation.as_of_date,
    basis: valuation.basis,
    day_value_policy: valuation.day_value_policy,
    settlement_year: valuation.settlement_year,
    booked_2920: roundOre(booked.booked2920),
    booked_2940: roundOre(booked.booked2940),
    computed_liability: computedLiability,
    computed_avgifter: computedAvgifter,
    difference_2920: difference2920,
    difference_2940: difference2940,
    rows,
    lines: [
      ...sideLines(
        rows,
        (r) => r.adjustment_2920,
        (r) => r.account,
        SALARY_ACCOUNTS.VACATION_ACCRUAL_LIABILITY,
        REMEASURE_LINE_TEXT,
        orphan2920,
        DEFAULT_CHANGE_ACCOUNT,
      ),
      ...sideLines(
        rows,
        (r) => r.adjustment_2940,
        () => SALARY_ACCOUNTS.VACATION_AVGIFTER_EXPENSE,
        SALARY_ACCOUNTS.VACATION_AVGIFTER_LIABILITY,
        REMEASURE_AVGIFTER_LINE_TEXT,
        orphan2940,
        SALARY_ACCOUNTS.VACATION_AVGIFTER_EXPENSE,
      ),
    ],
  }
}

/** One side of the verifikat: cost buckets per account and dimensions bag, the liability as one line. */
function sideLines(
  rows: readonly RemeasurePlanRow[],
  amountOf: (row: RemeasurePlanRow) => number,
  accountOf: (row: RemeasurePlanRow) => string,
  liabilityAccount: string,
  text: string,
  orphan: number,
  orphanAccount: string,
): CreateJournalEntryLineInput[] {
  const buckets = new Map<string, { account: string; dimensions?: LineDimensions; amount: number }>()
  for (const row of rows) {
    const amount = amountOf(row)
    if (!amount) continue
    const account = accountOf(row)
    const dimensions = row.dimensions ?? undefined
    const key = `${account}\u0000${dimensionsBagKey(dimensions)}`
    const bucket = buckets.get(key) ?? { account, dimensions, amount: 0 }
    bucket.amount = roundOre(bucket.amount + amount)
    buckets.set(key, bucket)
  }
  if (roundOre(orphan) !== 0) buckets.set(orphanAccount, { account: orphanAccount, amount: roundOre(orphan) })
  const costs = [...buckets.values()].filter((b) => b.amount !== 0)
  const total = sumOre(costs.map((b) => b.amount))
  if (Math.abs(total) <= DRIFT_TOLERANCE_SEK && costs.every((b) => Math.abs(b.amount) <= DRIFT_TOLERANCE_SEK)) return []
  const lines: CreateJournalEntryLineInput[] = costs
    .sort((a, b) => a.account.localeCompare(b.account) || dimensionsBagKey(a.dimensions).localeCompare(dimensionsBagKey(b.dimensions)))
    .map((b) => ({
      account_number: b.account,
      ...debitNatural(b.amount),
      line_description: text,
      ...(b.dimensions ? { dimensions: b.dimensions } : {}),
    }))
  if (total !== 0) {
    lines.push({ account_number: liabilityAccount, ...creditNatural(total), line_description: text })
  }
  return lines
}
