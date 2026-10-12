/**
 * Why a pending operation was rejected (pending_operations.rejection_category).
 *
 * Two kinds share the column so every rejection says why, and a person's
 * verdict is told apart from the system's by the value alone:
 *   - a person's: what they said was wrong with the proposal. Only these are
 *     feedback on a suggestion.
 *   - the system's: nobody judged the proposal. It expired unanswered, was
 *     replaced by a newer one or handled another way, or failed when it was
 *     approved.
 *
 * Client-safe: plain constants, shared by the routes, the MCP tool and the UI.
 */
export const PERSON_REJECTION_CATEGORIES = [
  'wrong_category',
  'wrong_amount',
  'duplicate',
  'wrong_period',
  'other',
] as const

export const SYSTEM_REJECTION_CATEGORIES = ['expired', 'superseded', 'failed'] as const

export type PersonRejectionCategory = (typeof PERSON_REJECTION_CATEGORIES)[number]
export type SystemRejectionCategory = (typeof SYSTEM_REJECTION_CATEGORIES)[number]
