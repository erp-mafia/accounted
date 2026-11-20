/**
 * The vacation figures of one run row, for the run table's Semester column.
 *
 * A run row carries vacation pay in one of two places. Under procentregeln
 * and sammalöneregeln the run accrues semesterlöneskuld
 * (salary_run_employees.vacation_accrual). Under vacation_rule
 * 'semesterersattning' nothing accrues: the calculation pays the percentage
 * on every run as a semesterersättning line inside the gross
 * (calculation-engine.ts step 4b), so vacation_accrual is 0 by design. A
 * final settlement entered by hand is a semesterersättning line as well. The
 * accrual alone therefore read 0 kr for an employee whose vacation pay is on
 * the payslip (crm#2017); the column shows both.
 */
import { roundOre } from '@/lib/money'

interface RunRowVacationSource {
  vacation_accrual?: number | string | null
  line_items?: ReadonlyArray<{ item_type?: unknown; amount?: number | string | null }> | null
}

export interface RunRowVacation {
  /** Semesterlöneskuld the run accrues for the employee. */
  accrued: number
  /** Semesterersättning the payslip pays out with the salary. */
  paidOut: number
}

export function runRowVacation(row: RunRowVacationSource): RunRowVacation {
  const accrued = roundOre(Number(row.vacation_accrual) || 0)
  let paidOut = 0
  for (const line of row.line_items ?? []) {
    if (line.item_type !== 'semesterersattning') continue
    paidOut = roundOre(paidOut + (Number(line.amount) || 0))
  }
  return { accrued, paidOut }
}
