/**
 * How long a background run may keep starting new work.
 *
 * A scheduled job is killed by the platform at its maxDuration: no result,
 * no log line, and whatever came after the loop it was in (mails, a second
 * sweep) never runs. A run that calls another service once per row is at the
 * mercy of that service's slowest day, however small its row limit: twelve
 * bank reads at 25 s each are a whole 300 s run (the payment status cron,
 * 2026-11-10). So the run carries a budget, asks it before each unit of
 * work, and stops while there is still time to finish what it started and
 * report what it left. What is left is picked up by the next run, which is
 * why the work is read oldest first.
 *
 * The budget is for starting work, not for finishing it: set it far enough
 * inside maxDuration that the slowest unit started at the last moment still
 * ends in time.
 */

export interface RunBudget {
  /** Epoch ms after which no new unit of work starts. */
  readonly deadline: number
  /** Whether a unit of work may still start; with `ms`, one that needs that long before the deadline. */
  allows(ms?: number): boolean
}

export function runBudget(startedAt: number, budgetMs: number, now: () => number = Date.now): RunBudget {
  const deadline = startedAt + budgetMs
  return { deadline, allows: (ms = 0) => now() + ms <= deadline }
}

/** No limit: a caller that is not a scheduled run (a script, a test of the work itself). */
export const UNLIMITED_RUN: RunBudget = { deadline: Number.POSITIVE_INFINITY, allows: () => true }
