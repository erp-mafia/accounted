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
 * longer be stored. #2058
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
