/**
 * The ombud check against Skatteverket's ombudsregister is paced: one real
 * check a minute per company. A check that arrives inside that minute is
 * refused with a 429 that names the wait (for #206: the refusal used to say
 * "wait a minute" and leave the person to come back and click again).
 *
 * Pure, and shared by both ends: the skatteverket extension computes the
 * wait it names, and the pages that check (settings, Hem, Kom igång) decide
 * from it whether to ask again by themselves. They do so a bounded number of
 * times, never sooner than the server said, and then hand back to the person.
 */

/** The wait assumed when a refusal names none: the full pacing interval. */
export const OMBUD_VERIFY_DEFAULT_WAIT_SECONDS = 60

/** Checks the page makes by itself after a refusal, before the person has to ask again. */
export const OMBUD_VERIFY_MAX_AUTO_RETRIES = 2

/** A named wait longer than this is not waited out by the page: the person is told to come back. */
export const OMBUD_VERIFY_MAX_WAIT_SECONDS = 120

/** Added to the named wait, so the retry lands after the limit lifted and not on its edge. */
const MARGIN_SECONDS = 1

/**
 * Whole seconds until the next check is allowed, for the 429 the server
 * answers: at least 1, at most the interval. An unreadable timestamp gets the
 * full interval.
 */
export function ombudVerifyRetryAfterSeconds(lastCheckedAt: string | null, nowMs: number, intervalMs: number): number {
  const full = Math.max(1, Math.ceil(intervalMs / 1000))
  const last = lastCheckedAt ? new Date(lastCheckedAt).getTime() : NaN
  if (!Number.isFinite(last)) return full
  const left = Math.ceil((last + intervalMs - nowMs) / 1000)
  return Math.min(full, Math.max(1, left))
}

/**
 * The wait a refusal names: the body's own number first (retry_after_seconds),
 * then the Retry-After header in its seconds form. Null when neither is a
 * positive number.
 */
export function namedRetryAfterSeconds(bodyValue: unknown, header: string | null): number | null {
  const candidates = [bodyValue, header !== null && header.trim() !== '' ? Number(header) : null]
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) return Math.ceil(candidate)
  }
  return null
}

export type OmbudVerifyRetryDecision =
  /** Ask again by itself after `waitSeconds`. */
  | { retry: true; waitSeconds: number }
  /** Stop: the person asks again when they want to. */
  | { retry: false }

/**
 * What to do with a rate-limited check. `retriesDone` counts the automatic
 * retries already made for this return to the page. The wait is the one the
 * server named (the full interval when it named none) plus a second, so a
 * retry never comes sooner than the limit; no retry past the bound, and none
 * for a wait too long to sit through.
 */
export function ombudVerifyRetryDecision(input: { retriesDone: number; retryAfterSeconds: number | null }): OmbudVerifyRetryDecision {
  if (input.retriesDone >= OMBUD_VERIFY_MAX_AUTO_RETRIES) return { retry: false }
  const named = input.retryAfterSeconds
  const wait = named !== null && Number.isFinite(named) && named > 0 ? Math.ceil(named) : OMBUD_VERIFY_DEFAULT_WAIT_SECONDS
  if (wait > OMBUD_VERIFY_MAX_WAIT_SECONDS) return { retry: false }
  return { retry: true, waitSeconds: wait + MARGIN_SECONDS }
}
