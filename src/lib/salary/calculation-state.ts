/**
 * Whether a salary run's calculation is current: the one rule the run page,
 * the review step and the approve step share.
 *
 * A calculation is recorded on two levels. salary_runs.calculation_params is
 * the run-level snapshot every calculation freezes (an empty roster, a
 * nolldeklaration, included), and it is never cleared again.
 * salary_run_employees.calculation_breakdown is the per-employee proof that
 * the engine ran against the current inputs: every write that changes an
 * input the engine reads clears it (invalidate-calculation.ts), and an
 * employee added after the calculation arrives without one. The approve and
 * book steps refuse a roster row without a breakdown.
 *
 * The run page used to read only the run-level snapshot, so after a payment
 * date change it kept the old figures on screen, offered "Till granskning",
 * the review step let the run through, and approval then refused it as
 * "Beräkning saknas" from a status where Beräkna is no longer offered
 * (crm#1001). Both levels together are the rule.
 *
 * Pure and dependency-free: the run page imports it into a client bundle.
 */

export type RunCalculationState = 'not_calculated' | 'stale' | 'current'

/** A salary_runs row, as far as this rule reads it. */
export interface RunCalculationSource {
  status: string
  calculation_params?: unknown
}

/** A salary_run_employees row, as far as this rule reads it. */
export interface RosterCalculationSource {
  calculation_breakdown?: unknown
}

/**
 * The statuses before approval. Past them the calculation is frozen: approve
 * refused any roster row without a breakdown, and a booked run's figures are
 * what was posted, so they are current by definition.
 */
export const PRE_APPROVAL_STATUSES = ['draft', 'review'] as const

/** Roster rows the engine has no current calculation for. */
export function rosterRowsWithoutCalculation<T extends RosterCalculationSource>(
  roster: readonly T[],
): T[] {
  return roster.filter((row) => row.calculation_breakdown == null)
}

/**
 * not_calculated: the run has never been calculated.
 * stale: it was, but an input changed since, so its figures are not the ones
 *   approval and booking would accept; it must be calculated again.
 * current: its figures are the calculation of its current inputs.
 */
export function runCalculationState(
  run: RunCalculationSource,
  roster: readonly RosterCalculationSource[],
): RunCalculationState {
  if (run.calculation_params == null) return 'not_calculated'
  if ((PRE_APPROVAL_STATUSES as readonly string[]).includes(run.status) && rosterRowsWithoutCalculation(roster).length > 0) {
    return 'stale'
  }
  return 'current'
}
