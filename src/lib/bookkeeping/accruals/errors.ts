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

export const ACCRUAL_REPLAN_INVALID = 'ACCRUAL_REPLAN_INVALID' as const

/** Why a re-plan of the months not yet posted was refused (details.reason). */
export type AccrualReplanRefusal =
  | 'accrued_cost'
  | 'accrued_income'
  | 'nothing_pending'
  | 'end_before_posted'
  | 'end_before_start'
  | 'no_month_left'
  | 'cancelled_months'
  | 'no_change'
  | 'amount_too_small'

const REPLAN_REFUSAL_SV: Record<AccrualReplanRefusal, string> = {
  accrued_cost:
    'En upplupen kostnad bokas på varje månads sista dag före fakturan och planeras inte om. Kreditera fakturan och registrera om den för en annan period.',
  accrued_income:
    'En upplupen intäkt bokas på varje månads sista dag före fakturan och planeras inte om. Kreditera fakturan och skapa en ny för en annan period.',
  nothing_pending: 'Alla månader är redan bokförda, så det finns inget kvar att planera om.',
  end_before_posted: 'Det nya slutdatumet ligger före en månad som redan är bokförd.',
  end_before_start: 'Slutdatumet ligger före periodens start.',
  no_month_left: 'Det nya slutdatumet lämnar ingen obokförd månad att fördela det återstående på.',
  cancelled_months: 'Periodiseringen håller på att avslutas genom en kreditering och kan inte planeras om.',
  no_change: 'Inget ändras: välj ett annat slutdatum eller en annan bokföringsdag.',
  amount_too_small: 'Det som återstår är för litet för att fördelas över så många månader.',
}

export class AccrualReplanInvalidError extends Error {
  readonly code = ACCRUAL_REPLAN_INVALID
  constructor(public readonly reason: AccrualReplanRefusal) {
    super(REPLAN_REFUSAL_SV[reason])
    this.name = 'AccrualReplanInvalidError'
  }
}

export function isAccrualError(
  err: unknown,
): err is
  | AccrualScheduleNotFoundError
  | AccrualScheduleNotActiveError
  | AccrualNothingToDissolveError
  | AccrualReplanInvalidError {
  return (
    err instanceof AccrualScheduleNotFoundError ||
    err instanceof AccrualScheduleNotActiveError ||
    err instanceof AccrualNothingToDissolveError ||
    err instanceof AccrualReplanInvalidError
  )
}
