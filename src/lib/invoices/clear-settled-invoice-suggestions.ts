import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'

const log = createLogger('invoices/clear-settled-invoice-suggestions')

export type SettledInvoiceKind = 'invoice' | 'supplier_invoice' | 'rot_rut_payout_request'

const HINT_COLUMN_BY_KIND: Record<SettledInvoiceKind, string> = {
  invoice: 'potential_invoice_id',
  supplier_invoice: 'potential_supplier_invoice_id',
  rot_rut_payout_request: 'potential_rot_rut_payout_request_id',
}

/**
 * Retire the match SUGGESTIONS that point at an invoice which has just been
 * fully settled.
 *
 * potential_invoice_id / potential_supplier_invoice_id are written once, at
 * bank import (lib/transactions/ingest.ts) or by the retro-match handler, and
 * nothing revisited them. When one of several identical recurring invoices was
 * paid off by a DIFFERENT transaction, every other transaction kept a pointer
 * at a now fully paid invoice. Read paths already refuse to offer such a
 * candidate (lib/invoices/matchable-statuses.ts, lib/worklist/categories.ts,
 * the transactions page), but the row still blocks a fresh suggestion: both
 * re-suggestion scans require the column to be NULL
 * (lib/bookkeeping/handlers/supplier-invoice-handler.ts and
 * app/api/transactions/batch-match-invoices/route.ts).
 *
 * This complements the read-time revalidation rather than replacing it: the
 * guards stay the backstop for the settle paths not wired up here.
 *
 * Call ONLY when the invoice is fully settled: a partially paid invoice is
 * still matchable, so its suggestions must survive.
 *
 * Best-effort and non-fatal by construction: every caller has already booked a
 * payment verifikat, so a failed cleanup must never fail the settle.
 */
export async function clearSettledInvoiceSuggestions(
  supabase: SupabaseClient,
  companyId: string,
  kind: SettledInvoiceKind,
  invoiceId: string,
  options?: { exceptTransactionId?: string | null },
): Promise<void> {
  const column = HINT_COLUMN_BY_KIND[kind]
  let query = supabase
    .from('transactions')
    .update({ [column]: null })
    // company_id is defense in depth: service-role callers have no RLS.
    .eq('company_id', companyId)
    // Never widen: only this invoice's own pointer, never any other hint and
    // never the confirmed link columns (invoice_id / supplier_invoice_id).
    .eq(column, invoiceId)
  if (options?.exceptTransactionId) {
    query = query.neq('id', options.exceptTransactionId)
  }
  const { error } = await query
  if (error) {
    log.warn('failed to clear settled invoice suggestions', {
      companyId,
      kind,
      invoiceId,
      reason: error.message,
    })
  }
}
