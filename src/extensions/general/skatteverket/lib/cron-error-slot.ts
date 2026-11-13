/**
 * When a kvittens cron raises the failures it keeps meeting at error level.
 *
 * A pending declaration never expires, so one Skatteverket keeps refusing is
 * in every run until a person acts. Raised on every run that is 96 error
 * reports a day for one row from the AGI cron (every 15 minutes), each saying
 * nothing the first did not. A cron keeps nothing between runs, so the gate
 * is the run's own clock: the run that starts within the first
 * `cronIntervalMs` of each six-hour UTC window (00:00, 06:00, 12:00, 18:00)
 * raises, every other run logs the same counts at warn. A failure first met
 * in another run is raised within six hours when the slot's run reaches the
 * row (a run stopped by its time budget, or whose rotation starts after the
 * row, may not), and at most four times a day however many runs meet it.
 * Deterministic: the answer depends on the start time alone, which a test
 * sets.
 */

export const CRON_ERROR_WINDOW_MS = 6 * 60 * 60 * 1000

/**
 * True for the one run per CRON_ERROR_WINDOW_MS that raises. `cronIntervalMs`
 * is the time between two runs on the cron's schedule (vercel.json): exactly
 * one scheduled start falls in the first interval of each window.
 */
export function cronRunRaisesErrors(runStartedAtMs: number, cronIntervalMs: number): boolean {
  return runStartedAtMs % CRON_ERROR_WINDOW_MS < cronIntervalMs
}
