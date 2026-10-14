import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { eventBus } from '@/lib/events'
import { CreateInvoiceSchema, CreateCreditNoteSchema } from '@/lib/api/schemas'
import type { Invoice, InvoiceDocumentType } from '@/types'
import {
  ensureInvoiceNumber,
  invoiceNumberingFailure,
  InvoiceNumberSeriesBehindError,
} from '@/lib/invoices/ensure-invoice-number'
import { buildInvoiceWriteData } from '@/lib/invoices/build-invoice-write'
import { resolveInvoicePayeeChoice } from '@/lib/invoices/invoice-payee'
import { createCreditNoteDraft, creditNoteRefusal } from '@/lib/invoices/credit-invoice'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import type { Logger } from '@/lib/logger'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { maskEmbeddedCustomer } from '@/lib/customers/protect-personal-number'
import {
  fetchInvoiceRegisterCoverage,
  NO_INVOICE_REGISTER_COVERAGE,
} from '@/lib/invoices/invoice-register-coverage'

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

    // Coverage disclosure: the register is complete only from covers_from
    // (invoices registered from the books before it are included), so for a
    // migrated/backfilled company this list is silently incomplete before
    // that date. Non-fatal: a failed lookup degrades to "no marker", never to
    // a failed list.
    let coverage = NO_INVOICE_REGISTER_COVERAGE
    try {
      coverage = await fetchInvoiceRegisterCoverage(supabase, companyId)
    } catch {
      // keep NO_INVOICE_REGISTER_COVERAGE
    }

    // Mask the embedded customer's personnummer: the customers(*) join
    // carries the stored ciphertext, which has no business reaching a client.
    return NextResponse.json({
      data: (data ?? []).map(maskEmbeddedCustomer),
      count,
      invoice_register_coverage: coverage,
    })
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

    // Which bank account the customer pays to (null = the per-currency
    // default). Validated against the company's payee accounts; the payee
    // fields are frozen on the row and refreshed again at issue.
    const payeeChoice = await resolveInvoicePayeeChoice(
      supabase,
      companyId!,
      invoiceInput.currency,
      invoiceInput.payment_cash_account_id,
    )
    if (!payeeChoice.ok) {
      return errorResponseFromCode(payeeChoice.code, log, { requestId, details: payeeChoice.details })
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

    // Delivery notes and quotes are always numbered at insert from their own
    // series (ignores save_as_draft): neither is a faktura, so no F-number is
    // at stake. Invoices/proformas get their F-number below or at finalize.
    let invoiceNumber: string | null = null
    if (documentType === 'delivery_note') {
      const { data: dnNumber } = await supabase.rpc('generate_delivery_note_number', {
        p_company_id: companyId,
      })
      invoiceNumber = dnNumber
    } else if (documentType === 'quote') {
      const { data: quoteNumber, error: quoteNumberError } = await supabase.rpc('generate_quote_number', {
        p_company_id: companyId,
      })
      if (quoteNumberError || !quoteNumber) {
        log.error('quote number allocation failed', quoteNumberError ?? new Error('no number'))
        return errorResponseFromCode('INVOICE_CREATE_NUMBER_ASSIGN_FAILED', log, { requestId })
      }
      invoiceNumber = quoteNumber
    }

    const { data: invoice, error: invoiceError } = await supabase
      .from('invoices')
      .insert({
        user_id: user.id,
        company_id: companyId,
        invoice_number: invoiceNumber,
        ...build.invoiceFields,
        payment_cash_account_id: payeeChoice.fields.payment_cash_account_id,
        payment_details: payeeChoice.fields.payment_details,
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
        // The series refusal uses up nothing (generate_invoice_number rolls back
        // before any write), so the unnumbered row can go: no number, no gap.
        // The editor keeps the form, and the create after the company set
        // where its series continues starts clean.
        if (err instanceof InvoiceNumberSeriesBehindError) {
          const { error: deleteErr } = await supabase
            .from('invoices')
            .delete()
            .eq('id', invoice.id)
            .eq('company_id', companyId!)
            .eq('status', 'draft')
            .is('invoice_number', null)
          if (deleteErr) {
            log.error('invoice series refusal: unnumbered draft could not be removed', deleteErr, {
              invoiceId: invoice.id,
            })
          }
          const failure = invoiceNumberingFailure(err, 'INVOICE_CREATE_NUMBER_ASSIGN_FAILED')
          return errorResponseFromCode(failure.code, log, {
            requestId,
            messageSv: failure.messageSv,
            messageEn: failure.messageEn,
            details: failure.details,
          })
        }
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

    // Non-blocking VAT-treatment warnings ride next to the row (absent when
    // there are none): why an EU customer got 25 %, or a Swedish rate on a
    // reverse-charge invoice (#2749, #2558). Same list the v1 route puts in
    // meta.warnings and the MCP preview in vat_warnings.
    return NextResponse.json({
      data: maskEmbeddedCustomer(completeInvoice),
      ...(build.warnings.length > 0 ? { warnings: build.warnings } : {}),
    })
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

  // The guard list every credit door runs (lib/invoices/credit-invoice.ts),
  // a credit note as the original included.
  const refusal = creditNoteRefusal(originalInvoice)
  if (refusal) {
    return errorResponseFromCode(refusal.code, log, {
      requestId,
      ...(refusal.details ? { details: refusal.details } : {}),
    })
  }

  // A credit note is only issued when the user sends it or marks it as sent.
  // Until then it is a non-editable draft: no journal entry is created and
  // the original invoice remains in its current state. An existing credit
  // note is returned (idempotent) and a cancelled, unissued one reopened.
  const draft = await createCreditNoteDraft(supabase, companyId, userId, originalInvoice, input, log)
  if (!draft.ok) {
    if (draft.code === 'DB_ERROR') {
      return errorResponse(draft.dbError ?? new Error('Credit note draft failed'), log, { requestId })
    }
    return errorResponseFromCode(draft.code, log, {
      requestId,
      ...(draft.dbError
        ? { details: { pgCode: draft.dbError.code, pgMessage: getUserErrorMessage(draft.dbError) } }
        : {}),
    })
  }
  return NextResponse.json({ data: maskEmbeddedCustomer(draft.creditNote) })
}
