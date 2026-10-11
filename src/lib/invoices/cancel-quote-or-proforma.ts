/**
 * Cancel (makulera) a quote or a proforma invoice: the document stays, with
 * status 'cancelled'. Neither carries a verifikat, so nothing is reversed.
 * A sales invoice never comes here: a draft is deleted
 * (delete-draft-invoice.ts) and an issued one is credited.
 *
 * The invoice.cancelled event is the audit trail: the event log records who
 * cancelled which document and when, which a direct row update from the
 * browser never did.
 *
 * The actor is an explicit parameter, as in delete-draft-invoice.ts: a
 * service-role caller has no auth.uid().
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { eventBus } from '@/lib/events'
import type { Invoice } from '@/types'

const CANCELLABLE_DOCUMENT_TYPES = new Set(['quote', 'proforma'])

export type CancelQuoteOrProformaResult =
  /** Cancelled now, or already cancelled (no second event). */
  | { ok: true; invoice: Invoice; alreadyCancelled: boolean }
  | { ok: false; code: 'INVOICE_NOT_FOUND' }
  | { ok: false; code: 'INVOICE_CANCEL_NOT_QUOTE_OR_PROFORMA'; documentType: string }
  /** The status changed between the read and the write. */
  | { ok: false; code: 'INVOICE_CANCEL_RACE' }
  | { ok: false; code: 'DB_ERROR'; cause: { message: string; code?: string } }

export async function cancelQuoteOrProforma(params: {
  supabase: SupabaseClient
  companyId: string
  userId: string
  invoiceId: string
}): Promise<CancelQuoteOrProformaResult> {
  const { supabase, companyId, userId, invoiceId } = params

  const { data: current, error: fetchError } = await supabase
    .from('invoices')
    .select('*')
    .eq('id', invoiceId)
    .eq('company_id', companyId)
    .maybeSingle()

  if (fetchError) {
    return { ok: false, code: 'DB_ERROR', cause: { message: fetchError.message, code: fetchError.code } }
  }
  if (!current) return { ok: false, code: 'INVOICE_NOT_FOUND' }

  const documentType = (current.document_type as string | null) ?? 'invoice'
  if (!CANCELLABLE_DOCUMENT_TYPES.has(documentType)) {
    return { ok: false, code: 'INVOICE_CANCEL_NOT_QUOTE_OR_PROFORMA', documentType }
  }
  if (current.status === 'cancelled') {
    return { ok: true, invoice: current as Invoice, alreadyCancelled: true }
  }

  // Compare-and-set on the status just read: a conversion or a second
  // cancel landing in between makes this a 0-row update, not an overwrite.
  const { data: updated, error: updateError } = await supabase
    .from('invoices')
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('id', invoiceId)
    .eq('company_id', companyId)
    .eq('status', current.status)
    .select('*')
    .maybeSingle()

  if (updateError) {
    return { ok: false, code: 'DB_ERROR', cause: { message: updateError.message, code: updateError.code } }
  }
  if (!updated) return { ok: false, code: 'INVOICE_CANCEL_RACE' }

  await eventBus.emit({
    type: 'invoice.cancelled',
    payload: { invoice: updated as Invoice, userId, companyId },
  })

  return { ok: true, invoice: updated as Invoice, alreadyCancelled: false }
}
