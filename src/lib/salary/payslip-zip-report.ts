/**
 * Reporting for the bulk payslip ZIP on the salary run page.
 *
 * The archive is assembled in the browser, one PDF request per employee, so a
 * single request can fail while the rest succeed. A partial archive must never
 * be presented as complete: the employer hands out whatever the ZIP contains
 * and has no other signal that someone is missing from it. These helpers turn
 * the per-employee outcomes into one truthful verdict the page can render as a
 * single toast (the toaster keeps only one toast at a time, so a warning next
 * to a success message would be evicted unseen).
 *
 * Pure on purpose: the page renders it, the tests exercise it. Vitest runs in a
 * node env here and does not render components.
 */

/** How many missing names to spell out before collapsing the rest into a count. */
export const MAX_LISTED_MISSING = 5

export interface PayslipZipAttempt {
  /** Display label for the employee, see payslipEmployeeLabel(). */
  name: string
  /** True only when the PDF actually made it into the archive. */
  ok: boolean
}

/**
 * - `empty`: nothing was attempted (run has no employees).
 * - `none`: every payslip failed, the archive would be empty.
 * - `partial`: the archive exists but is missing at least one employee.
 * - `complete`: every employee is in the archive.
 */
export type PayslipZipOutcome = 'empty' | 'none' | 'partial' | 'complete'

export interface PayslipZipReport {
  outcome: PayslipZipOutcome
  total: number
  added: number
  failed: number
  /** Every employee missing from the archive, in run order. */
  missing: string[]
  /** The first `maxListed` of `missing`, for display. */
  missingShown: string[]
  /** How many missing names `missingShown` leaves out. */
  missingOverflow: number
}

/**
 * Turn per-employee ZIP outcomes into a report that names who is missing.
 *
 * The old logic only counted successes and warned when the count hit zero, so a
 * batch of 20 that produced 17 payslips reported plain success. Anything short
 * of every employee is a partial archive here.
 */
export function buildPayslipZipReport(
  attempts: readonly PayslipZipAttempt[],
  maxListed: number = MAX_LISTED_MISSING,
): PayslipZipReport {
  const total = attempts.length
  const missing = attempts.filter((a) => !a.ok).map((a) => a.name)
  const failed = missing.length
  const added = total - failed

  const outcome: PayslipZipOutcome =
    total === 0 ? 'empty' : failed === 0 ? 'complete' : added === 0 ? 'none' : 'partial'

  const limit = Math.max(0, maxListed)
  return {
    outcome,
    total,
    added,
    failed,
    missing,
    missingShown: missing.slice(0, limit),
    missingOverflow: Math.max(0, failed - limit),
  }
}

/**
 * Label for one employee in the archive report. Mirrors the ZIP filename
 * fallback: the employee relation can be absent on a run row, and an unnameable
 * employee still has to be reported as missing rather than quietly dropped.
 */
export function payslipEmployeeLabel(
  employeeId: string,
  employee?: { first_name?: string | null; last_name?: string | null } | null,
): string {
  const first = employee?.first_name?.trim() ?? ''
  const last = employee?.last_name?.trim() ?? ''
  const full = `${first} ${last}`.trim()
  return full || employeeId.slice(0, 8)
}
