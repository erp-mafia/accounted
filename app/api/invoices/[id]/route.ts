import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { eventBus } from '@/lib/events'
import { ensureInitialized } from '@/lib/init'
import { requireCompanyId } from '@/lib/company/context'
import { requireWritePermission } from '@/lib/auth/require-write'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { createLogger } from '@/lib/logger'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { UpdateInvoiceSchema } from '@/lib/api/schemas'
import { buildInvoiceWriteData } from '@/lib/invoices/build-invoice-write'
import { isEditableInvoiceDraft } from '@/lib/invoices/is-editable-draft'
import type { InvoiceDocumentType } from '@/types'

ensureInitialized() // Module-level: wires the audit-log handler for invoice.draft_deleted.

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
 *    makulerad: the row and its number are retained and status flips to
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
  // yet issued invoices (no F-series number was consumed) so they can be hard
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
      // Finalized between fetch and delete: refuse rather than fall through to
      // makulering of a now-issued invoice.
      return errorResponseFromCode('INVOICE_CANCEL_RACE', log)
    }

    // The row is gone, so there's no journal trace of the removal. Emit an
    // audit event carrying the identifiers so the event log records who deleted
    // which draft and when: the makulering path leaves a journal/status trail,
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

/**
 * PATCH /api/invoices/[id]
 *
 * Edit a DRAFT invoice (or proforma / delivery note) in place: header fields
 * AND line items. Only drafts are editable: a journal entry (verifikat) is
 * created when an invoice is sent (mark-sent / send) or, for kontantmetoden, at
 * payment, so a draft has no committed entry and BFL immutability (guard rail #1)
 * does not yet apply. Sent / paid / cancelled / credited invoices are immutable
 * and must be reversed via a credit note instead.
 *
 * The invoice's number and status are preserved: editing never (re)allocates a
 * number nor changes lifecycle state, and never emits invoice.created (numbered
 * drafts already emitted it at create; unnumbered ones emit on finalize). The
 * validation + computation is shared with POST /api/invoices via
 * buildInvoiceWriteData so VAT rules, ROT/RUT, accruals and totals stay identical.
 */
export const PATCH = withRouteContext<{ params: Promise<{ id: string }> }>(
  'invoice.update',
  async (request, { supabase, companyId, log: ctxLog, requestId }, { params }) => {
    const { id } = await params

    const validation = await validateBody(request, UpdateInvoiceSchema, {
      log: ctxLog,
      operation: 'invoice.update',
    })
    if (!validation.success) return validation.response
    const input = validation.data
    const documentType: InvoiceDocumentType = input.document_type || 'invoice'

    // Fetch the target. Only drafts (not sent, no committed verifikat, not a
    // received self-billing document) may be edited.
    const { data: existing, error: fetchError } = await supabase
      .from('invoices')
      .select('id, status, invoice_number, journal_entry_id, is_self_billed')
      .eq('id', id)
      .eq('company_id', companyId!)
      .single()

    if (fetchError || !existing) {
      return errorResponseFromCode('INVOICE_NOT_FOUND', ctxLog, { requestId })
    }

    // journal_entry_id is belt-and-suspenders: a draft shouldn't carry one,
    // but if some flow ever booked it, refuse the edit (the entry is immutable).
    // Shared predicate (lib/invoices/is-editable-draft): the single source of
    // truth the detail and edit pages also gate on, so the rule can't drift.
    if (!isEditableInvoiceDraft(existing)) {
      return errorResponseFromCode('INVOICE_UPDATE_NOT_DRAFT', ctxLog, { requestId })
    }

    // Resolve the (possibly changed) customer.
    const { data: customer, error: customerError } = await supabase
      .from('customers')
      .select('*')
      .eq('id', input.customer_id)
      .eq('company_id', companyId!)
      .single()

    if (customerError || !customer) {
      return errorResponseFromCode('INVOICE_CUSTOMER_NOT_FOUND', ctxLog, {
        requestId,
        details: { customerId: input.customer_id },
      })
    }

    const build = await buildInvoiceWriteData({
      supabase,
      companyId: companyId!,
      customer,
      documentType,
      input,
    })
    if (!build.ok) {
      if ('dbError' in build) {
        ctxLog.error('invoice write build failed on a DB lookup', build.dbError as Error)
        return errorResponse(build.dbError, ctxLog, { requestId })
      }
      return errorResponseFromCode(build.code, ctxLog, { requestId, details: build.details })
    }

    // Update the draft row. invoice_number + status are intentionally NOT in
    // build.invoiceFields, so they are preserved. The .eq('status','draft')
    // guard turns a concurrent send/finalize into a 0-row update (race), rather
    // than silently rewriting a now-issued invoice.
    // Öresavrundning is display-only and optional in the update body. Persist
    // it when the editor sent a value; otherwise strip it so a partial update
    // can't reset a draft's stored flag (build defaults an absent flag to null).
    const updateFields =
      input.ore_rounding === undefined
        ? (() => {
            const { ore_rounding: _oreRounding, ...rest } = build.invoiceFields
            return rest
          })()
        : build.invoiceFields
    const { data: updated, error: updateError } = await supabase
      .from('invoices')
      .update({ ...updateFields, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('company_id', companyId!)
      .eq('status', 'draft')
      .select('id')

    if (updateError) {
      ctxLog.error('invoice update failed', updateError, { invoiceId: id })
      return errorResponseFromCode('INVOICE_CREATE_INSERT_FAILED', ctxLog, {
        requestId,
        details: { pgCode: updateError.code, pgMessage: updateError.message },
      })
    }
    if (!updated || updated.length === 0) {
      return errorResponseFromCode('INVOICE_UPDATE_NOT_DRAFT', ctxLog, { requestId })
    }

    // Replace line items wholesale. A draft has no journal entry or linked docs,
    // so delete + reinsert is safe and lets the user add / remove / reorder rows
    // freely. invoice_items cascade nothing else.
    const { error: deleteItemsError } = await supabase
      .from('invoice_items')
      .delete()
      .eq('invoice_id', id)

    if (deleteItemsError) {
      ctxLog.error('invoice items delete failed on update', deleteItemsError, { invoiceId: id })
      return errorResponseFromCode('INVOICE_CREATE_ITEMS_FAILED', ctxLog, {
        requestId,
        details: { pgCode: deleteItemsError.code, pgMessage: deleteItemsError.message },
      })
    }

    const itemsToInsert = build.items.map((item) => ({ ...item, invoice_id: id }))
    const { error: itemsError } = await supabase.from('invoice_items').insert(itemsToInsert)

    if (itemsError) {
      ctxLog.error('invoice items insert failed on update', itemsError, { invoiceId: id })
      return errorResponseFromCode('INVOICE_CREATE_ITEMS_FAILED', ctxLog, {
        requestId,
        details: { pgCode: itemsError.code, pgMessage: itemsError.message },
      })
    }

    const { data: completeInvoice } = await supabase
      .from('invoices')
      .select('*, customer:customers(*), items:invoice_items(*)')
      .eq('id', id)
      .single()

    return NextResponse.json({ data: completeInvoice })
  },
  { requireWrite: true },
)
