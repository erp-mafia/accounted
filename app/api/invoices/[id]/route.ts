import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { eventBus } from '@/lib/events'
import { ensureInitialized } from '@/lib/init'
import { requireCompanyId } from '@/lib/company/context'
import { requireWritePermission } from '@/lib/auth/require-write'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { createLogger } from '@/lib/logger'

ensureInitialized() // Module-level — wires the audit-log handler for invoice.draft_deleted.

const log = createLogger('api.invoices.cancel')

/**
 * DELETE /api/invoices/[id]
 *
 * Removes a draft invoice. Behaviour depends on whether a number was issued:
 *
 *  - Unnumbered draft (saved via "Spara som utkast", never finalized): hard
 *    deleted. No F-series number was consumed, so there is no gap to document
 *    (ML 17 kap 24§). invoice_items cascade via the FK.
 *  - Numbered draft (created directly, or finalized via "Granska och skapa"):
 *    makulerad — the row and its number are retained and status flips to
 *    'cancelled', keeping the F-series gap-free per ML 17 kap 24§ / BFNAR 2013:2.
 *
 * Only drafts may be removed either way. Sent / paid invoices are immutable per
 * BFL and must be reversed via a credit note instead.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const writeCheck = await requireWritePermission(supabase, user.id)
  if (!writeCheck.ok) return writeCheck.response

  const companyId = await requireCompanyId(supabase, user.id)

  const { data: invoice, error: fetchError } = await supabase
    .from('invoices')
    .select('id, status, invoice_number, user_id')
    .eq('id', id)
    .eq('company_id', companyId)
    .single()

  if (fetchError || !invoice) {
    return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
  }

  if (invoice.status !== 'draft') {
    return errorResponseFromCode('INVOICE_DELETE_NOT_DRAFT', log)
  }

  // Unnumbered drafts (saved via "Spara som utkast", never finalized) are not
  // yet issued invoices — no F-series number was consumed — so they can be hard
  // deleted with no gap in the sequence (ML 17 kap 24§). invoice_items cascade
  // via the FK (ON DELETE CASCADE); an un-finalized draft has no journal entry
  // or linked document. The status='draft' + invoice_number IS NULL guard makes
  // the delete a no-op if the row was finalized (numbered) concurrently.
  if (!invoice.invoice_number) {
    const { data: removed, error: removeError } = await supabase
      .from('invoices')
      .delete()
      .eq('id', id)
      .eq('company_id', companyId)
      .eq('status', 'draft')
      .is('invoice_number', null)
      .select('id')

    if (removeError) {
      return NextResponse.json({ error: removeError.message }, { status: 500 })
    }

    if (!removed || removed.length === 0) {
      // Finalized between fetch and delete — refuse rather than fall through to
      // makulering of a now-issued invoice.
      return errorResponseFromCode('INVOICE_CANCEL_RACE', log)
    }

    // The row is gone, so there's no journal trace of the removal. Emit an
    // audit event carrying the identifiers so the event log records who deleted
    // which draft and when — the makulering path leaves a journal/status trail,
    // a hard delete otherwise leaves none.
    await eventBus.emit({
      type: 'invoice.draft_deleted',
      payload: { invoiceId: id, companyId, userId: user.id },
    })

    return NextResponse.json({ data: { deleted: true } })
  }

  // Numbered draft: retain the row and its number, flip to 'cancelled'
  // (makulering) so the F-series stays gap-free.
  // .select() returns the affected rows so we can detect a TOCTOU race where
  // the status flipped between the fetch above and this update. With only the
  // .eq('status','draft') guard, a 0-row update returns success and the user
  // would see "Makulerad" while the invoice is still in its previous state.
  const { data: updated, error: cancelError } = await supabase
    .from('invoices')
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('company_id', companyId)
    .eq('status', 'draft')
    .select('id')

  if (cancelError) {
    return NextResponse.json({ error: cancelError.message }, { status: 500 })
  }

  if (!updated || updated.length === 0) {
    return errorResponseFromCode('INVOICE_CANCEL_RACE', log)
  }

  return NextResponse.json({ data: { cancelled: true, invoice_number: invoice.invoice_number } })
}
