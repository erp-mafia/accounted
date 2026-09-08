/**
 * The matcher's own record of what it decided, acted on or not.
 *
 * Shadow mode from fraud detection: the candidate system sees every input,
 * its output is logged next to what the human eventually did, and a segment
 * is switched on when the measured agreement clears a bar. Every arrival run
 * writes one row per document it looked at, including the ones it skipped:
 * a skipped document that the human then matched by hand is the recall
 * figure, and it is invisible if only proposals are logged.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'

const log = createLogger('underlag/shadow-log')

export type ShadowTrigger = 'arrival' | 'bank_sync' | 'cron' | 'manual'
export type ShadowDecision = 'link' | 'propose' | 'skip'
export type ShadowDecidedBy = 'matcher' | 'adjudicator' | 'veto' | 'autonomy'

export interface ShadowRow {
  company_id: string
  user_id: string | null
  run_id: string
  trigger: ShadowTrigger
  inbox_item_id: string | null
  document_id: string | null
  transaction_id: string | null
  counterparty_key: string | null
  confidence: number | null
  calibrated_p: number | null
  components: Record<string, unknown>
  decision: ShadowDecision
  decided_by: ShadowDecidedBy
  reason: string | null
  acted: boolean
}

/** Best-effort insert: a logging failure must never fail the run it describes. */
export async function insertShadowRows(supabase: SupabaseClient, rows: ShadowRow[]): Promise<void> {
  if (rows.length === 0) return
  const { error } = await supabase.from('match_shadow_log').insert(rows)
  if (error) {
    log.error('failed to insert shadow rows', { message: error.message, rows: rows.length })
  }
}

/**
 * Close the loop: when a human links, approves or rejects a pair, stamp the
 * outcome on every open shadow row for that document.
 *
 * Goes through record_match_shadow_outcome, the one sanctioned write after
 * insert: the table itself is append-only, and the function sets the
 * outcome once. `agree` when the human landed on the transaction the
 * matcher chose, `rejected` when they refused the matcher's pair, `disagree`
 * otherwise. Rows that named no transaction (skips) are marked from the
 * human's choice alone: a skip followed by a manual match is a miss.
 */
export async function recordShadowOutcome(
  supabase: SupabaseClient,
  companyId: string,
  documentId: string,
  outcome: { transactionId: string | null; rejectedTransactionId?: string | null },
): Promise<void> {
  const { error } = await supabase.rpc('record_match_shadow_outcome', {
    p_company_id: companyId,
    p_document_id: documentId,
    p_transaction_id: outcome.transactionId,
    p_rejected_transaction_id: outcome.rejectedTransactionId ?? null,
  })
  if (error) log.error('failed to record outcome', { message: error.message, documentId })
}
