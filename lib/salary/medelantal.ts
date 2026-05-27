/**
 * Medelantal anställda — time-weighted FTE average across a fiscal period.
 *
 * Per ÅRL 5:20 § the medelantal disclosure is the average number of
 * full-time-equivalent employees over the räkenskapsår, not a snapshot
 * headcount. An employee hired on July 1 of a calendar-year FY counts as
 * 0.5; an employee on 50 % degree employed all year counts as 0.5; an
 * employee hired Mar 1 at 80 % and terminated Aug 31 counts as
 *   (184 days / 365 days) × 0.80 ≈ 0.40.
 *
 * Inputs come from public.employees:
 *   - employment_start: required (DATE NOT NULL)
 *   - employment_end: optional (DATE) — when null, employee is still active
 *     on the period end date
 *   - employment_degree: 0 < degree <= 100, default 100
 *
 * The result is rounded to the nearest whole employee per Swedish ÅR
 * disclosure convention (Skatteverket / FAR practice; ÅRL doesn't specify
 * a precision but whole numbers are universal in K2 ÅR for mindre företag).
 */

export interface EmployeePeriodInput {
  employment_start: string
  employment_end: string | null
  /** 0 < degree <= 100. 100 = full-time. */
  employment_degree: number
}

/** Inclusive day count between two ISO dates (UTC). 2025-01-01..2025-12-31 = 365. */
function inclusiveDays(startIso: string, endIso: string): number {
  const start = new Date(`${startIso}T00:00:00Z`)
  const end = new Date(`${endIso}T00:00:00Z`)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0
  if (end < start) return 0
  return Math.floor((end.getTime() - start.getTime()) / 86400000) + 1
}

/**
 * Compute the FTE-weighted medelantal anställda for a fiscal period.
 *
 * @param employees rows with employment_start / employment_end / employment_degree
 * @param periodStartIso fiscal period start (inclusive), ISO YYYY-MM-DD
 * @param periodEndIso fiscal period end (inclusive), ISO YYYY-MM-DD
 * @returns rounded whole-number medelantal, or 0 if no qualifying overlap
 */
export function computeMedelantalAnstallda(
  employees: EmployeePeriodInput[],
  periodStartIso: string,
  periodEndIso: string,
): number {
  const periodDays = inclusiveDays(periodStartIso, periodEndIso)
  if (periodDays === 0) return 0

  let totalFteDays = 0
  for (const e of employees) {
    const overlapStart =
      e.employment_start > periodStartIso ? e.employment_start : periodStartIso
    const employmentEnd = e.employment_end ?? periodEndIso
    const overlapEnd =
      employmentEnd < periodEndIso ? employmentEnd : periodEndIso
    if (overlapStart > overlapEnd) continue
    const overlapDays = inclusiveDays(overlapStart, overlapEnd)
    const degreeFactor = Math.min(100, Math.max(0, e.employment_degree)) / 100
    totalFteDays += overlapDays * degreeFactor
  }

  return Math.round(totalFteDays / periodDays)
}
