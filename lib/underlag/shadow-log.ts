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
 * `agree` when the human landed on the transaction the matcher chose,
 * `disagree` when they chose another, `rejected` when they said no to the
 * matcher's pair. Rows that named no transaction (skips) are marked from the
 * human's choice alone: a skip followed by a manual match is a miss.
 */
export async function recordShadowOutcome(
  supabase: SupabaseClient,
  companyId: string,
  documentId: string,
  outcome: { transactionId: string | null; rejectedTransactionId?: string | null },
): Promise<void> {
  const { data: open, error } = await supabase
    .from('match_shadow_log')
    .select('id, transaction_id')
    .eq('company_id', companyId)
    .eq('document_id', documentId)
    .is('human_outcome', null)
    .limit(200)
  if (error || !open || open.length === 0) return

  const now = new Date().toISOString()
  const updates = (open as Array<{ id: string; transaction_id: string | null }>).map((row) => {
    let human_outcome: 'agree' | 'disagree' | 'rejected'
    if (outcome.rejectedTransactionId && row.transaction_id === outcome.rejectedTransactionId) {
      human_outcome = 'rejected'
    } else if (outcome.transactionId && row.transaction_id === outcome.transactionId) {
      human_outcome = 'agree'
    } else {
      human_outcome = 'disagree'
    }
    return supabase
      .from('match_shadow_log')
      .update({ human_outcome, outcome_at: now })
      .eq('id', row.id)
  })
  const results = await Promise.all(updates)
  for (const r of results) {
    if (r.error) log.error('failed to record outcome', { message: r.error.message, documentId })
  }
}
