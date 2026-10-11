import type { SupabaseClient } from '@supabase/supabase-js'

type MatchAction =
  | 'matched'
  | 'unmatched'
  | 'auto_suggested'
  | 'suggestion_cleared'
  | 'storno_conflict_resolved'
  | 'linked_to_existing_voucher'

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
    await supabase.from('payment_match_log').insert({
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
  } catch {
    // Non-critical: audit log insert must never break the main flow
  }
}
