/**
 * Typed domain errors for the periodisering (accrual schedule) service.
 *
 * Mirrors the lib/bookkeeping/errors.ts pattern: each class carries a stable
 * `code` so API routes dispatch on the code instead of matching Swedish prose.
 * The Swedish messages are user-facing and intentionally unchanged from the
 * original plain-Error throws.
 */

export const ACCRUAL_SCHEDULE_NOT_FOUND = 'ACCRUAL_SCHEDULE_NOT_FOUND' as const
export const ACCRUAL_SCHEDULE_NOT_ACTIVE = 'ACCRUAL_SCHEDULE_NOT_ACTIVE' as const
export const ACCRUAL_NOTHING_TO_DISSOLVE = 'ACCRUAL_NOTHING_TO_DISSOLVE' as const

export class AccrualScheduleNotFoundError extends Error {
  readonly code = ACCRUAL_SCHEDULE_NOT_FOUND
  constructor() {
    super('Periodiseringen hittades inte')
    this.name = 'AccrualScheduleNotFoundError'
  }
}

export class AccrualScheduleNotActiveError extends Error {
  readonly code = ACCRUAL_SCHEDULE_NOT_ACTIVE
  constructor(public readonly currentStatus: string) {
    super('Periodiseringen är inte aktiv')
    this.name = 'AccrualScheduleNotActiveError'
  }
}

export class AccrualNothingToDissolveError extends Error {
  readonly code = ACCRUAL_NOTHING_TO_DISSOLVE
  constructor() {
    super('Det finns inget kvar att lösa upp')
    this.name = 'AccrualNothingToDissolveError'
  }
}

export function isAccrualError(
  err: unknown,
): err is
  | AccrualScheduleNotFoundError
  | AccrualScheduleNotActiveError
  | AccrualNothingToDissolveError {
  return (
    err instanceof AccrualScheduleNotFoundError ||
    err instanceof AccrualScheduleNotActiveError ||
    err instanceof AccrualNothingToDissolveError
  )
}
