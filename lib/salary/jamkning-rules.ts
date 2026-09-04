/**
 * The one validator for a jämkningsbeslut (Skatteverket beslut om ändrad
 * beräkning av skatteavdrag) on an employee row.
 *
 * The calculation engine (isJamkningValid in calculation-engine.ts) applies
 * the beslut only when BOTH dates are set and the payment date falls inside
 * them. A percentage stored with a missing date is therefore inert: the
 * payslip and the AGI carry the table tax while the caller was told 200.
 * Every write path (web routes, v1 REST, MCP staging and executors, the Zod
 * schemas) runs the merged row through this function so that shape can no
 * longer be stored. #2058. The database declares the same rule as the CHECK
 * constraint employees_jamkning_dates_check (#2256), so a concurrent or
 * direct write cannot store it either; see jamkningIssueFromDbError below.
 *
 * Setting the percentage to null clears the beslut; the dates are then free.
 */

export const JAMKNING_FIELDS = ['jamkning_percentage', 'jamkning_valid_from', 'jamkning_valid_to'] as const

export type JamkningField = (typeof JAMKNING_FIELDS)[number]

export interface JamkningFields {
  jamkning_percentage?: number | null
  jamkning_valid_from?: string | null
  jamkning_valid_to?: string | null
}

export interface JamkningIssue {
  field: 'jamkning_valid_from' | 'jamkning_valid_to'
  message: string
}

export const JAMKNING_START_REQUIRED = 'Jämkningens startdatum måste anges när jämkningsprocent sätts'
export const JAMKNING_END_REQUIRED = 'Jämkningens slutdatum måste anges när jämkningsprocent sätts'
export const JAMKNING_ORDER = 'Jämkningens slutdatum måste vara efter startdatumet'

/**
 * Validates the MERGED jämkning state of a row (existing row + patch for an
 * update, the full body for a create). Returns every issue found, in field
 * order, so callers can either join the messages or surface the first one.
 */
export function validateJamkning(fields: JamkningFields): JamkningIssue[] {
  const issues: JamkningIssue[] = []
  const percentage = fields.jamkning_percentage
  const from = fields.jamkning_valid_from
  const to = fields.jamkning_valid_to
  const hasBeslut = percentage !== null && percentage !== undefined

  if (hasBeslut && !from) {
    issues.push({ field: 'jamkning_valid_from', message: JAMKNING_START_REQUIRED })
  }
  if (hasBeslut && !to) {
    issues.push({ field: 'jamkning_valid_to', message: JAMKNING_END_REQUIRED })
  }
  if (from && to && to < from) {
    issues.push({ field: 'jamkning_valid_to', message: JAMKNING_ORDER })
  }
  return issues
}

/**
 * True when a sparse patch names any jämkning key (an explicit null counts).
 * Update paths only validate when this holds: a legacy row stored with an
 * incomplete beslut must stay editable in unrelated ways, since fixing it
 * requires touching these very fields.
 */
export function touchesJamkning(patch: Record<string, unknown>): boolean {
  return JAMKNING_FIELDS.some((key) => key in patch)
}

/**
 * The database backstop for the same invariant: CHECK constraint
 * employees_jamkning_dates_check (migration 20260904120000, #2256), the
 * rule above declared on the row itself. It is what an update sees when its
 * merged-state check passed against a snapshot another request has since
 * changed (the concurrent-PATCH race), and what ANY edit of a row stored
 * incomplete before #2240 sees: the constraint was added NOT VALID, so such
 * a row is checked on its next UPDATE and must be completed or cleared then.
 */
export const JAMKNING_CHECK_CONSTRAINT = 'employees_jamkning_dates_check'

/**
 * Sentence for a constraint rejection the merged row cannot explain: the
 * row on disk is no longer the snapshot the caller validated against.
 */
export const JAMKNING_ROW_INCOMPLETE =
  'Jämkningen måste ha både startdatum och slutdatum, och slutdatumet får inte ligga före startdatumet. Ladda om uppgifterna och försök igen'

/**
 * The issue behind a rejection by employees_jamkning_dates_check, or null
 * when the error is anything else. Matches SQLSTATE 23514 plus the
 * constraint name: Postgres puts it in the message ('new row for relation
 * "employees" violates check constraint "employees_jamkning_dates_check"'),
 * which PostgREST forwards verbatim as `message`, and node-postgres also
 * exposes it as `constraint`.
 *
 * A CHECK violation does not say which clause failed, so the sentence is
 * recovered from the row the caller meant to store (`merged`: existing row
 * plus patch). For a legacy incomplete row that is the exact validator
 * sentence, naming the missing date. When that row passes the validator the
 * rejection came from a concurrent change, and the umbrella sentence is
 * returned instead.
 */
export function jamkningIssueFromDbError(error: unknown, merged: JamkningFields = {}): JamkningIssue | null {
  if (typeof error !== 'object' || error === null) return null
  const { code, message, constraint } = error as { code?: unknown; message?: unknown; constraint?: unknown }
  if (code !== '23514') return null
  const named =
    constraint === JAMKNING_CHECK_CONSTRAINT ||
    (typeof message === 'string' && message.includes(`"${JAMKNING_CHECK_CONSTRAINT}"`))
  if (!named) return null
  const [issue] = validateJamkning(merged)
  return issue ?? { field: 'jamkning_valid_to', message: JAMKNING_ROW_INCOMPLETE }
}
