/**
 * Decision logic for scripts/repair-customer-personal-number-in-org-number.ts.
 *
 * A customer_type='individual' row must not carry an org number: a
 * privatperson has none, and its personnummer belongs encrypted in
 * personal_number. Rows written before every write path enforced that hold
 * the personnummer in plaintext in org_number. This decides, per row, what
 * the repair does; the script only selects, counts and writes.
 *
 * Pure: the caller passes the decrypt function, so the tests run without a
 * key and the script never prints a value.
 */
import {
  looksLikeSwedishPersonalNumber,
  personalNumberDigits,
} from '@/lib/customers/personal-number-shape'

export interface OrgNumberRepairRow {
  customer_type: string | null
  org_number: string | null
  /** Ciphertext as stored (or legacy plaintext); null when none is stored. */
  personal_number: string | null
}

/**
 * - `move`: personal_number is empty; the org number is encrypted into it and
 *   org_number is cleared.
 * - `clear_same`: personal_number already holds the same personnummer;
 *   org_number is cleared.
 * - `clear_differ`: personal_number holds a different personnummer; the
 *   stored one wins (it was entered in the field meant for it) and
 *   org_number is cleared. Counted so the founder sees how many.
 * - `skip_unreadable`: the stored personal_number cannot be decrypted, so
 *   same and differ cannot be told apart; the row is left alone.
 * - `skip_not_personal_number`: org_number is not a personnummer (a business
 *   filed as an individual, or a typo); the row is left alone for a manual
 *   decision.
 */
export type OrgNumberRepairAction =
  | 'move'
  | 'clear_same'
  | 'clear_differ'
  | 'skip_unreadable'
  | 'skip_not_personal_number'

export const ORG_NUMBER_REPAIR_ACTIONS: readonly OrgNumberRepairAction[] = [
  'move',
  'clear_same',
  'clear_differ',
  'skip_unreadable',
  'skip_not_personal_number',
]

/** True for the actions that write. */
export function isWritingAction(action: OrgNumberRepairAction): boolean {
  return action === 'move' || action === 'clear_same' || action === 'clear_differ'
}

/**
 * The action for one row, or null when the row is out of scope: not an
 * individual, or no org number (null or blank, which is no number at all).
 */
export function planOrgNumberRepair(
  row: OrgNumberRepairRow,
  decrypt: (stored: string) => string,
): OrgNumberRepairAction | null {
  if (row.customer_type !== 'individual') return null
  if (row.org_number === null || row.org_number.trim() === '') return null
  if (!looksLikeSwedishPersonalNumber(row.org_number)) return 'skip_not_personal_number'
  if (!row.personal_number) return 'move'

  let stored: string
  try {
    stored = decrypt(row.personal_number)
  } catch {
    return 'skip_unreadable'
  }
  return personalNumberDigits(stored) === personalNumberDigits(row.org_number) ? 'clear_same' : 'clear_differ'
}

export type OrgNumberRepairCounts = Record<OrgNumberRepairAction, number>

/** Counts per action; every action is present, zero when unused. */
export function countOrgNumberRepairActions(actions: Iterable<OrgNumberRepairAction>): OrgNumberRepairCounts {
  const counts = Object.fromEntries(ORG_NUMBER_REPAIR_ACTIONS.map((a) => [a, 0])) as OrgNumberRepairCounts
  for (const action of actions) counts[action] += 1
  return counts
}
