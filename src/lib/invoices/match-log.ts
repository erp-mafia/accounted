import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'

const log = createLogger('invoices/match-log')

/**
 * Every value must also be in the payment_match_log.action CHECK (latest:
 * migration 20261013160000) and in tests/pg/payment-match-log-actions.pg.test.ts:
 * a value the CHECK lacks is refused, and the refusal is only logged (the
 * insert never fails the match it records).
 */
export type MatchAction =
  | 'matched'
  | 'unmatched'
  | 'auto_suggested'
  | 'suggestion_cleared'
  | 'storno_conflict_resolved'
  | 'linked_to_existing_voucher'
  /** Booked without a person: the debit of a bank payment order settled its invoice. */
  | 'auto_matched'

/**
 * Log a payment match event to the append-only audit trail.
 * Never throws. Always await it: an un-awaited insert races the response,
 * and a serverless function can freeze before the row lands
 * (__tests__/match-log-awaited.test.ts).
 */
export async function logMatchEvent(
  supabase: SupabaseClient,
  userId: string,
  transactionId: string,
  action: MatchAction,
  opts?: {
    invoiceId?: string
    supplierInvoiceId?: string
    matchConfidence?: number
    matchMethod?: string
    previousState?: Record<string, unknown>
    newState?: Record<string, unknown>
  }
): Promise<void> {
  try {
    const { error } = await supabase.from('payment_match_log').insert({
      user_id: userId,
      transaction_id: transactionId,
      invoice_id: opts?.invoiceId ?? null,
      supplier_invoice_id: opts?.supplierInvoiceId ?? null,
      action,
      match_confidence: opts?.matchConfidence ?? null,
      match_method: opts?.matchMethod ?? null,
      previous_state: opts?.previousState ?? null,
      new_state: opts?.newState ?? null,
    })
    // supabase-js answers a refused insert (the action CHECK, RLS, a foreign key) with an error, never a throw.
    if (error) log.error('payment match audit row not written', { transactionId, action, code: error.code, message: error.message })
  } catch (err) {
    // The audit row must never break the match it records, but a lost row is a gap in the trail.
    log.error('payment match audit row not written', err as Error, { transactionId, action })
  }
}
