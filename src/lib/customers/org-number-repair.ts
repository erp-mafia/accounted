/**
 * The personnummer repair, run by
 * scripts/repair-customer-personal-number-in-org-number.ts and, since the
 * production key exists only in the deployed app, by the one-off cron
 * /api/customers/personal-number-repair/cron.
 *
 * A customer_type='individual' row must not carry an org number: a
 * privatperson has none, and its personnummer belongs encrypted in
 * personal_number. Rows written before every write path enforced that hold
 * the personnummer in plaintext in org_number. planOrgNumberRepair decides,
 * per row, what the repair does; repairIndividualOrgNumbers selects, counts
 * and writes.
 *
 * The decision is pure: the caller passes the decrypt function, so the tests
 * run without a key. A run reports counts only, never a value or an id.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import {
  encryptCustomerPersonalNumber,
  revealStoredCustomerPersonalNumber,
} from '@/lib/customers/protect-personal-number'
import {
  looksLikeSwedishPersonalNumber,
  normalizeReroutedPersonalNumber,
  personalNumberDigits,
} from '@/lib/invariants/personal-number-shape'

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
    // Undecryptable is the answer itself: the row is counted and left alone.
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

export interface OrgNumberRepairRunOptions {
  /** False: read, decide and count; nothing is written. */
  apply: boolean
  /** Limits the run to one company. */
  companyId?: string | null
  /** Epoch ms after which no further row is written; a re-run carries on. */
  deadline?: number
  /** The system actor the audit_log rows name. */
  actorLabel: string
}

export interface OrgNumberRepairRun {
  /** Individuals with a non-blank org_number, and their companies. */
  individuals: number
  companies: number
  counts: OrgNumberRepairCounts
  written: number
  /** Rows that changed between the read and the guarded write: skipped. */
  changedUnderneath: number
  /** Failed writes by error code. */
  failed: Record<string, number>
  /**
   * Why the run stopped before trying every writing row: the deadline, or a
   * failed audit_log insert, which leaves the last written row without its
   * audit row (auditError holds the code).
   */
  stopped: null | 'deadline' | 'audit_failed'
  auditError?: string
}

interface RepairRow {
  id: string
  company_id: string
  user_id: string
  customer_type: string
  org_number: string
  personal_number: string | null
}

/**
 * Decides every individual with a non-blank org_number and, with apply,
 * writes the decision. Every write is guarded on the exact values the
 * decision was made on, so a concurrent edit or a re-run never double-applies;
 * a row that changed underneath is counted as skipped. Safe to re-run.
 */
export async function repairIndividualOrgNumbers(
  supabase: SupabaseClient,
  options: OrgNumberRepairRunOptions,
): Promise<OrgNumberRepairRun> {
  const rows = await fetchAllRows<RepairRow>(({ from, to }) => {
    let query = supabase
      .from('customers')
      .select('id, company_id, user_id, customer_type, org_number, personal_number')
      .eq('customer_type', 'individual')
      .not('org_number', 'is', null)
      .order('id', { ascending: true })
      .range(from, to)
    if (options.companyId) query = query.eq('company_id', options.companyId)
    return query
  })

  const planned: { row: RepairRow; action: OrgNumberRepairAction }[] = []
  for (const row of rows) {
    const action = planOrgNumberRepair(row, (stored) => revealStoredCustomerPersonalNumber(stored) ?? '')
    if (action) planned.push({ row, action })
  }
  const run: OrgNumberRepairRun = {
    individuals: planned.length,
    companies: new Set(planned.map((p) => p.row.company_id)).size,
    counts: countOrgNumberRepairActions(planned.map((p) => p.action)),
    written: 0,
    changedUnderneath: 0,
    failed: {},
    stopped: null,
  }
  if (!options.apply) return run

  for (const { row, action } of planned) {
    if (!isWritingAction(action)) continue
    if (options.deadline !== undefined && Date.now() >= options.deadline) {
      run.stopped = 'deadline'
      break
    }
    // Guarded on the values the decision was made on. Two literal payloads
    // so the no-phantom-columns scanner can resolve both.
    const result = action === 'move'
      ? await supabase
          .from('customers')
          .update({
            org_number: null,
            personal_number: encryptCustomerPersonalNumber(normalizeReroutedPersonalNumber(row.org_number)),
          })
          .eq('id', row.id)
          .eq('company_id', row.company_id)
          .eq('customer_type', 'individual')
          .eq('org_number', row.org_number)
          .is('personal_number', null)
          .select('id')
      : await supabase
          .from('customers')
          .update({ org_number: null })
          .eq('id', row.id)
          .eq('company_id', row.company_id)
          .eq('customer_type', 'individual')
          .eq('org_number', row.org_number)
          .eq('personal_number', row.personal_number!)
          .select('id')
    if (result.error) {
      // The code only: a message or detail could quote the row.
      const code = result.error.code || 'unknown'
      run.failed[code] = (run.failed[code] ?? 0) + 1
    } else if (!result.data || result.data.length === 0) {
      run.changedUnderneath += 1
    } else {
      run.written += 1
      // The per-row trace (BFNAR 2013:2 p. 9.16): ids and the action only, no
      // personnummer and no ciphertext. actor_type 'system' so it never reads
      // as something the company's user did. Written after the change, as the
      // app's other audit writers do. Not one transaction with the update, so
      // a failed audit row stops the run at once: at most one repaired row is
      // left without its trace, and the caller reports it.
      // A literal payload so the no-phantom-columns scanner checks it.
      const audit = await supabase.from('audit_log').insert({
        user_id: row.user_id,
        company_id: row.company_id,
        action: 'UPDATE',
        table_name: 'customers',
        record_id: row.id,
        actor_id: null,
        actor_type: 'system',
        actor_label: options.actorLabel,
        old_state: { org_number_set: true },
        new_state: { org_number: null, personal_number_set: true, repair_action: action },
        description: `Individual customer: org_number cleared (${action}); the personnummer is held encrypted in personal_number`,
      })
      if (audit.error) {
        run.stopped = 'audit_failed'
        run.auditError = audit.error.code || 'unknown'
        break
      }
    }
  }
  return run
}
