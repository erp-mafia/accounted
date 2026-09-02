import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { eventBus } from '@/lib/events'
import { ensureInitialized } from '@/lib/init'
import { CreateInvoiceSchema, CreateCreditNoteSchema } from '@/lib/api/schemas'
import type { Invoice, InvoiceDocumentType, InvoiceItem } from '@/types'
import { ensureInvoiceNumber } from '@/lib/invoices/ensure-invoice-number'
import { buildInvoiceWriteData } from '@/lib/invoices/build-invoice-write'
import { buildCreditNoteItem } from '@/lib/invoices/build-credit-note-item'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import type { Logger } from '@/lib/logger'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { maskEmbeddedCustomer } from '@/lib/customers/protect-personal-number'

ensureInitialized()

export const GET = withRouteContext(
  'invoice.list',
  async (request, ctx) => {
    const { supabase, companyId, log, requestId } = ctx

    const { searchParams } = new URL(request.url)
    const status = searchParams.get('status')
    const limit = parseInt(searchParams.get('limit') || '50')
    const offset = parseInt(searchParams.get('offset') || '0')

    let query = supabase
      .from('invoices')
      .select('*, customer:customers(*)', { count: 'exact' })
      .eq('company_id', companyId)
      .order('invoice_date', { ascending: false })
      .range(offset, offset + limit - 1)

    if (status) {
      query = query.eq('status', status)
    }
    // Kundorder detail: the invoices created from one order.
    const salesOrderId = searchParams.get('sales_order_id')
    if (salesOrderId && /^[0-9a-f-]{36}$/i.test(salesOrderId)) {
      query = query.eq('sales_order_id', salesOrderId)
    }

    const { data, error, count } = await query

    if (error) {
      log.error('failed to list invoices', error)
      return errorResponse(error, log, { requestId })
    }

    // Mask the embedded customer's personnummer: the customers(*) join
    // carries the stored ciphertext, which has no business reaching a client.
    return NextResponse.json({ data: (data ?? []).map(maskEmbeddedCustomer), count })
  },
)

export const POST = withRouteContext(
  'invoice.create',
  async (request, ctx) => {
    const { user, supabase, companyId, log, requestId } = ctx

    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      log.warn('invalid json body', { kind: 'json' })
      return NextResponse.json(
        { error: 'Invalid JSON in request body', type: 'validation_error' },
        { status: 400 },
      )
    }

    if (typeof rawBody === 'object' && rawBody !== null && 'credited_invoice_id' in rawBody) {
      const parsed = CreateCreditNoteSchema.safeParse(rawBody)
      if (!parsed.success) {
        log.warn('credit note validation failed', {
          issueCount: parsed.error.issues.length,
        })
        return NextResponse.json(
          {
            error: 'Validation failed',
            type: 'validation_error',
            errors: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message, code: i.code })),
          },
          { status: 400 },
        )
      }
      return createCreditNote(supabase, companyId!, user.id, parsed.data, log, requestId)
    }

    const parsed = CreateInvoiceSchema.safeParse(rawBody)
    if (!parsed.success) {
      log.warn('invoice validation failed', { issueCount: parsed.error.issues.length })
      return NextResponse.json(
        {
          error: 'Validation failed',
          type: 'validation_error',
          errors: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message, code: i.code })),
        },
        { status: 400 },
      )
    }
    const invoiceInput = parsed.data
    const documentType: InvoiceDocumentType = invoiceInput.document_type || 'invoice'

    const { data: customer, error: customerError } = await supabase
      .from('customers')
      .select('*')
      .eq('id', invoiceInput.customer_id)
      .eq('company_id', companyId!)
      .single()

    if (customerError || !customer) {
      return errorResponseFromCode('INVOICE_CUSTOMER_NOT_FOUND', log, {
        requestId,
        details: { customerId: invoiceInput.customer_id },
      })
    }

    // Shared validation + computation (VAT rules, accrual guards, totals,
    // revenue-account override checks, server-side ROT/RUT, currency, item
    // rows). Identical to the PATCH (draft edit) path: see build-invoice-write.
    const build = await buildInvoiceWriteData({
      supabase,
      companyId: companyId!,
      customer,
      documentType,
      input: invoiceInput,
    })
    if (!build.ok) {
      if ('dbError' in build) {
        log.error('invoice write build failed on a DB lookup', build.dbError as Error)
        return errorResponse(build.dbError, log, { requestId })
      }
      return errorResponseFromCode(build.code, log, { requestId, details: build.details })
    }

    // Delivery notes are always numbered at insert (ignores save_as_draft);
    // invoices/proformas get their F-number below or at finalize.
    let invoiceNumber: string | null = null
    if (documentType === 'delivery_note') {
      const { data: dnNumber } = await supabase.rpc('generate_delivery_note_number', {
        p_company_id: companyId,
      })
      invoiceNumber = dnNumber
    }

    const { data: invoice, error: invoiceError } = await supabase
      .from('invoices')
      .insert({
        user_id: user.id,
        company_id: companyId,
        invoice_number: invoiceNumber,
        ...build.invoiceFields,
      })
      .select()
      .single()

    if (invoiceError) {
      log.error('invoice insert failed', invoiceError)
      return errorResponseFromCode('INVOICE_CREATE_INSERT_FAILED', log, {
        requestId,
        details: { pgCode: invoiceError.code, pgMessage: getUserErrorMessage(invoiceError) },
      })
    }

    const items = build.items.map((item) => ({ ...item, invoice_id: invoice.id }))

    const { error: itemsError } = await supabase.from('invoice_items').insert(items)

    if (itemsError) {
      // Roll back invoice insert; otherwise the row is orphaned.
      await supabase.from('invoices').delete().eq('id', invoice.id)
      log.error('invoice items insert failed; rolled back invoice', itemsError, {
        invoiceId: invoice.id,
      })
      return errorResponseFromCode('INVOICE_CREATE_ITEMS_FAILED', log, {
        requestId,
        details: { pgCode: itemsError.code, pgMessage: getUserErrorMessage(itemsError) },
      })
    }

    // Allocate the F-series number on save (Fortnox-style): UNLESS the caller
    // asked to save as an unnumbered draft. A direct create gives the user a
    // numbered draft they can download and send manually; "Spara som utkast"
    // (save_as_draft) defers numbering to the explicit "Granska och skapa" step
    // (POST /invoices/{id}/finalize) so the draft can be hard-deleted with no
    // gap in the F-series per ML 17 kap 24§. Delivery notes are always numbered
    // at insert above and ignore the flag.
    if (!invoiceInput.save_as_draft && (documentType === 'invoice' || documentType === 'proforma')) {
      try {
        await ensureInvoiceNumber(supabase, companyId!, invoice as Invoice)
      } catch (err) {
        // Soft-cancel rather than hard-delete: if generate_invoice_number bumped
        // the sequence before failing to write the number back, hard-deleting
        // would leave a permanent gap in the F-series in violation of ML 17 kap
        // 24§. Re-fetch the row to pick up any partially-written number, then
        // flip status='cancelled' so the row (and any allocated number) is
        // retained for audit. Log loudly if the cancel itself fails so an
        // operator can clean up.
        const { data: latest } = await supabase
          .from('invoices')
          .select('invoice_number')
          .eq('id', invoice.id)
          .single()
        // Guard on status='draft' for symmetry with the DELETE handler: only
        // drafts may be cancelled. At this point in the create flow the row
        // can't realistically be anything else, but the symmetry prevents a
        // future caller adding a status flip between insert and number-
        // allocation from accidentally cancelling a posted invoice.
        const { error: cancelErr } = await supabase
          .from('invoices')
          .update({ status: 'cancelled', updated_at: new Date().toISOString() })
          .eq('id', invoice.id)
          .eq('company_id', companyId!)
          .eq('status', 'draft')
        if (cancelErr) {
          log.error('invoice number allocation failed AND rollback-cancel failed; row may be orphaned', cancelErr, {
            invoiceId: invoice.id,
            allocatedNumber: latest?.invoice_number ?? null,
            originalError: (err as Error).message,
          })
        } else {
          log.error('invoice number allocation failed; invoice soft-cancelled', err as Error, {
            invoiceId: invoice.id,
            allocatedNumber: latest?.invoice_number ?? null,
          })
        }
        return errorResponseFromCode('INVOICE_CREATE_NUMBER_ASSIGN_FAILED', log, {
          requestId,
        })
      }
    }

    const { data: completeInvoice } = await supabase
      .from('invoices')
      .select('*, customer:customers(*), items:invoice_items(*)')
      .eq('id', invoice.id)
      .single()

    // Emit event only for real, issued invoices. Unnumbered drafts (save_as_draft)
    // are not issued yet: the invoice.created event (which drives webhooks and the
    // audit log) fires when the user finalizes via "Granska och skapa".
    if (completeInvoice && documentType === 'invoice' && !invoiceInput.save_as_draft) {
      await eventBus.emit({
        type: 'invoice.created',
        payload: { invoice: completeInvoice as Invoice, companyId: companyId!, userId: user.id },
      })
    }

    return NextResponse.json({ data: maskEmbeddedCustomer(completeInvoice) })
  },
  { requireWrite: true },
)

async function createCreditNote(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  input: { credited_invoice_id: string; reason?: string },
  log: Logger,
  requestId: string,
) {
  const { data: originalInvoice, error: originalError } = await supabase
    .from('invoices')
    .select('*, items:invoice_items(*)')
    .eq('id', input.credited_invoice_id)
    .eq('company_id', companyId)
    .single()

  if (originalError || !originalInvoice) {
    return errorResponseFromCode('INVOICE_CREDIT_ORIGINAL_NOT_FOUND', log, { requestId })
  }

  if (originalInvoice.document_type && originalInvoice.document_type !== 'invoice') {
    return errorResponseFromCode('INVOICE_CREDIT_NOT_INVOICE', log, {
      requestId,
      details: { documentType: originalInvoice.document_type },
    })
  }

  if (originalInvoice.status === 'credited') {
    return errorResponseFromCode('INVOICE_CREDIT_ALREADY_CREDITED', log, { requestId })
  }

  // 'partially_paid' is missing from this list and that is a real gap, not a
  // rule: an aendringsfaktura per ML (2023:200) 17 kap 22-23 SS references the
  // original's loepnummer, and whether the customer has paid nothing, part or
  // all of it has no bearing on the right to issue one. It is NOT added here
  // alone, because this door is not where the flow ends: issueCreditNote()
  // (lib/invoices/issue-credit-note.ts) flips the original to 'credited' with
  // the same three-status compare-and-set, and it runs AFTER the reversing
  // verifikat is posted. Widening only this check would post an immutable
  // voucher and then fail on the status flip, leaving a fully credited invoice
  // sitting at 'partially_paid': open in the AR ledger and still chased by
  // reminders. Widening it is a coordinated change across the six sites listed
  // in DECISIONS.md, with issue-credit-note.ts first.
  //
  // Genuinely refused either way: 'draft' (never issued, so there is no
  // loepnummer for ML 17 kap 22 to reference) and 'cancelled'. 'credited' is
  // refused above.
  if (!['sent', 'paid', 'overdue'].includes(originalInvoice.status)) {
    return errorResponseFromCode('INVOICE_CREDIT_NOT_SENT', log, {
      requestId,
      details: { currentStatus: originalInvoice.status },
    })
  }

  // Self-billed originals have invoice_number null by design (the DB
  // constraint invoices_self_billed_numbering enforces it); their number
  // lives in external_invoice_number. Without this fallback the credit note
  // would be numbered the literal string 'KR-null' (issue #1820). Both null
  // is impossible for an issued invoice, but refuse defensively rather than
  // mint a garbage number.
  const originalRef = originalInvoice.invoice_number ?? originalInvoice.external_invoice_number
  if (!originalRef) {
    return errorResponseFromCode('INVOICE_CREDIT_NO_NUMBER', log, { requestId })
  }

  // Returning the existing credit note makes the action idempotent. A
  // cancelled, unissued draft is reopened so the deterministic KR number can
  // be reused without colliding with the company-wide invoice-number key.
  const { data: existingCreditNote, error: existingCreditNoteError } = await supabase
    .from('invoices')
    .select('*, customer:customers(*), items:invoice_items(*)')
    .eq('credited_invoice_id', input.credited_invoice_id)
    .eq('company_id', companyId)
    .eq('creation_complete', true)
    .maybeSingle()

  if (existingCreditNoteError) {
    log.error('failed to check for an existing credit note', existingCreditNoteError)
    return errorResponse(existingCreditNoteError, log, { requestId })
  }
  if (existingCreditNote) {
    if (existingCreditNote.status === 'cancelled' && !existingCreditNote.journal_entry_id) {
      const today = new Date().toISOString().split('T')[0]
      const { error: reopenError } = await supabase
        .from('invoices')
        .update({
          status: 'draft',
          invoice_date: today,
          due_date: today,
          notes: input.reason || `Krediterar faktura ${originalRef}`,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existingCreditNote.id)
        .eq('company_id', companyId)
        .eq('status', 'cancelled')

      if (reopenError) {
        log.error('failed to reopen cancelled credit note draft', reopenError)
        return errorResponse(reopenError, log, { requestId })
      }

      const { data: reopenedCreditNote, error: reopenedError } = await supabase
        .from('invoices')
        .select('*, customer:customers(*), items:invoice_items(*)')
        .eq('id', existingCreditNote.id)
        .eq('company_id', companyId)
        .single()

      if (reopenedError || !reopenedCreditNote) {
        return errorResponse(reopenedError ?? new Error('Credit note draft not found'), log, {
          requestId,
        })
      }
      return NextResponse.json({ data: maskEmbeddedCustomer(reopenedCreditNote) })
    }
    return NextResponse.json({ data: maskEmbeddedCustomer(existingCreditNote) })
  }

  const creditNoteNumber = `KR-${originalRef}`

  const { data: creditNote, error: creditNoteError } = await supabase
    .from('invoices')
    .insert({
      user_id: userId,
      company_id: companyId,
      customer_id: originalInvoice.customer_id,
      invoice_number: creditNoteNumber,
      invoice_date: new Date().toISOString().split('T')[0],
      due_date: new Date().toISOString().split('T')[0],
      delivery_date: originalInvoice.delivery_date ?? null,
      currency: originalInvoice.currency,
      exchange_rate: originalInvoice.exchange_rate,
      exchange_rate_date: originalInvoice.exchange_rate_date,
      subtotal: -Math.abs(originalInvoice.subtotal),
      subtotal_sek: originalInvoice.subtotal_sek ? -Math.abs(originalInvoice.subtotal_sek) : null,
      vat_amount: -Math.abs(originalInvoice.vat_amount),
      vat_amount_sek: originalInvoice.vat_amount_sek ? -Math.abs(originalInvoice.vat_amount_sek) : null,
      total: -Math.abs(originalInvoice.total),
      total_sek: originalInvoice.total_sek ? -Math.abs(originalInvoice.total_sek) : null,
      vat_treatment: originalInvoice.vat_treatment,
      vat_rate: originalInvoice.vat_rate,
      moms_ruta: originalInvoice.moms_ruta,
      reverse_charge_text: originalInvoice.reverse_charge_text,
      your_reference: originalInvoice.your_reference,
      our_reference: originalInvoice.our_reference,
      // Same buyer routing on the kreditfaktura as the original.
      invoice_marking: originalInvoice.invoice_marking ?? null,
      // Positive magnitude, unlike the negated amounts above: the DB has
      // CHECK (deduction_total >= 0), and every reader either recomputes the
      // ROT/RUT amount from the items or skips credit notes entirely.
      deduction_total: originalInvoice.deduction_total
        ? Math.abs(originalInvoice.deduction_total)
        : 0,
      deduction_personnummer_encrypted: originalInvoice.deduction_personnummer_encrypted ?? null,
      deduction_personnummer_last4: originalInvoice.deduction_personnummer_last4 ?? null,
      notes: input.reason || `Krediterar faktura ${originalRef}`,
      credited_invoice_id: input.credited_invoice_id,
      // Copy the original's dimension bag so the credit-note verifikat nets
      // against the same dimension cells in reports (dimensions PR7).
      default_dimensions: originalInvoice.default_dimensions ?? {},
      status: 'draft',
      creation_complete: false,
    })
    .select()
    .single()

  if (creditNoteError) {
    if (creditNoteError.code === '23505') {
      const { data: racedCreditNote } = await supabase
        .from('invoices')
        .select('*, customer:customers(*), items:invoice_items(*)')
        .eq('credited_invoice_id', input.credited_invoice_id)
        .eq('company_id', companyId)
        .eq('creation_complete', true)
        .maybeSingle()
      if (racedCreditNote) return NextResponse.json({ data: maskEmbeddedCustomer(racedCreditNote) })
    }
    log.error('credit note insert failed', creditNoteError)
    return errorResponseFromCode('INVOICE_CREATE_INSERT_FAILED', log, {
      requestId,
      details: { pgCode: creditNoteError.code, pgMessage: getUserErrorMessage(creditNoteError) },
    })
  }

  const creditNoteItems = (originalInvoice.items || []).map((item: InvoiceItem) =>
    buildCreditNoteItem(creditNote.id, item)
  )

  const { error: itemsError } = await supabase.from('invoice_items').insert(creditNoteItems)

  if (itemsError) {
    const { error: cleanupError } = await supabase
      .from('invoices')
      .delete()
      .eq('id', creditNote.id)
      .eq('company_id', companyId)
      .eq('creation_complete', false)
    if (cleanupError) {
      log.error('failed to clean up incomplete credit note', cleanupError, {
        creditNoteId: creditNote.id,
      })
    }
    log.error('credit note items insert failed; rolled back', itemsError, {
      creditNoteId: creditNote.id,
    })
    return errorResponseFromCode('INVOICE_CREATE_ITEMS_FAILED', log, {
      requestId,
      details: { pgCode: itemsError.code, pgMessage: getUserErrorMessage(itemsError) },
    })
  }

  const { error: completionError } = await supabase
    .from('invoices')
    .update({ creation_complete: true, updated_at: new Date().toISOString() })
    .eq('id', creditNote.id)
    .eq('company_id', companyId)
    .eq('creation_complete', false)

  if (completionError) {
    log.error('failed to mark credit note creation complete', completionError, {
      creditNoteId: creditNote.id,
    })
    return errorResponseFromCode('INVOICE_CREATE_ITEMS_FAILED', log, { requestId })
  }

  const { data: completeCreditNote, error: completeCreditNoteError } = await supabase
    .from('invoices')
    .select('*, customer:customers(*), items:invoice_items(*)')
    .eq('id', creditNote.id)
    .eq('company_id', companyId)
    .eq('creation_complete', true)
    .single()

  if (completeCreditNoteError || !completeCreditNote) {
    log.error('failed to read completed credit note', completeCreditNoteError)
    return errorResponseFromCode('INVOICE_CREATE_ITEMS_FAILED', log, { requestId })
  }

  // A credit note is only issued when the user sends it or marks it as sent.
  // Until then it is a non-editable draft: no journal entry is created and
  // the original invoice remains in its current state.
  return NextResponse.json({ data: maskEmbeddedCustomer(completeCreditNote) })
}
