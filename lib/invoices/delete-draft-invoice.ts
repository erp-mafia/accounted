/**
 * Draft customer-invoice deletion, shared by the cookie-session route
 * (DELETE /api/invoices/[id]), the v1 API-key route
 * (DELETE /api/v1/companies/{companyId}/invoices/{id}) and the MCP
 * delete_draft_invoice executor.
 *
 * Behaviour depends on whether an F-series number was issued:
 *
 *  - Unnumbered draft (saved via "Spara som utkast", never finalized): hard
 *    deleted. No F-series number was consumed, so there is no gap to document
 *    (ML 17 kap 24 paragraf). invoice_items cascade via the FK.
 *  - Numbered draft (created directly, or finalized via "Granska och skapa"):
 *    makulerad: the row and its number are retained and status flips to
 *    'cancelled', keeping the F-series gap-free per ML 17 kap 24 paragraf /
 *    BFNAR 2013:2.
 *
 * Only drafts may be removed either way. Sent / paid invoices are immutable
 * per BFL and must be reversed via a credit note instead. Posted journal
 * entries and documents linked to them are never touched here: a draft has
 * neither.
 *
 * The actor is an EXPLICIT parameter: v1 and MCP callers run on the
 * service-role client, where auth.uid() is null, so the caller's user id can
 * never be inferred from the client.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { eventBus } from '@/lib/events'
import type { Logger } from '@/lib/logger'

export type DeleteDraftInvoiceResult =
  /** Unnumbered draft hard-deleted; invoice.draft_deleted event emitted. */
  | { ok: true; outcome: 'deleted' }
  /** Numbered draft makulerad (status -> 'cancelled'), number retained. */
  | { ok: true; outcome: 'cancelled'; invoiceNumber: string }
  | { ok: false; code: 'INVOICE_NOT_FOUND' }
  | { ok: false; code: 'INVOICE_DELETE_NOT_DRAFT'; currentStatus: string }
  /** Status flipped between fetch and write (concurrent send/finalize). */
  | { ok: false; code: 'INVOICE_CANCEL_RACE' }
  | { ok: false; code: 'INVOICE_DELETE_FAILED'; cause: { message: string; code?: string } }

export interface DeleteDraftInvoiceParams {
  supabase: SupabaseClient
  companyId: string
  /**
   * Acting user's id, recorded on the invoice.draft_deleted audit event.
   * Passed explicitly: service-role clients null auth.uid().
   */
  userId: string
  invoiceId: string
  log?: Logger
}

export async function deleteDraftInvoice(
  params: DeleteDraftInvoiceParams,
): Promise<DeleteDraftInvoiceResult> {
  const { supabase, companyId, userId, invoiceId, log } = params

  const { data: invoice, error: fetchError } = await supabase
    .from('invoices')
    .select('id, status, invoice_number, user_id, credited_invoice_id, journal_entry_id')
    .eq('id', invoiceId)
    .eq('company_id', companyId)
    .single()

  if (fetchError || !invoice) {
    return { ok: false, code: 'INVOICE_NOT_FOUND' }
  }

  if (invoice.status !== 'draft') {
    return { ok: false, code: 'INVOICE_DELETE_NOT_DRAFT', currentStatus: invoice.status }
  }

  // Unnumbered drafts (saved via "Spara som utkast", never finalized) are not
  // yet issued invoices (no F-series number was consumed) so they can be hard
  // deleted with no gap in the sequence (ML 17 kap 24 paragraf). invoice_items
  // cascade via the FK (ON DELETE CASCADE); an un-finalized draft has no
  // journal entry or linked document. The status='draft' + invoice_number IS
  // NULL guard makes the delete a no-op if the row was finalized (numbered)
  // concurrently.
  if (!invoice.invoice_number) {
    const { data: removed, error: removeError } = await supabase
      .from('invoices')
      .delete()
      .eq('id', invoiceId)
      .eq('company_id', companyId)
      .eq('status', 'draft')
      .is('invoice_number', null)
      .select('id')

    if (removeError) {
      log?.error('invoice draft delete failed', removeError)
      return {
        ok: false,
        code: 'INVOICE_DELETE_FAILED',
        cause: { message: removeError.message, code: removeError.code },
      }
    }

    if (!removed || removed.length === 0) {
      // Finalized between fetch and delete: refuse rather than fall through to
      // makulering of a now-issued invoice.
      return { ok: false, code: 'INVOICE_CANCEL_RACE' }
    }

    // The row is gone, so there's no journal trace of the removal. Emit an
    // audit event carrying the identifiers so the event log records who
    // deleted which draft and when: the makulering path leaves a
    // journal/status trail, a hard delete otherwise leaves none.
    await eventBus.emit({
      type: 'invoice.draft_deleted',
      payload: { invoiceId, companyId, userId },
    })

    return { ok: true, outcome: 'deleted' }
  }

  // Numbered draft: retain the row and its number, flip to 'cancelled'
  // (makulering) so the F-series stays gap-free.
  // .select() returns the affected rows so we can detect a TOCTOU race where
  // the status flipped between the fetch above and this update. With only the
  // .eq('status','draft') guard, a 0-row update returns success and the caller
  // would see "Makulerad" while the invoice is still in its previous state.
  const { data: updated, error: cancelError } = await supabase
    .from('invoices')
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('id', invoiceId)
    .eq('company_id', companyId)
    .eq('status', 'draft')
    .select('id')

  if (cancelError) {
    log?.error('invoice cancellation failed', cancelError)
    return {
      ok: false,
      code: 'INVOICE_DELETE_FAILED',
      cause: { message: cancelError.message, code: cancelError.code },
    }
  }

  if (!updated || updated.length === 0) {
    return { ok: false, code: 'INVOICE_CANCEL_RACE' }
  }

  return { ok: true, outcome: 'cancelled', invoiceNumber: invoice.invoice_number }
}
