import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { eventBus } from '@/lib/events'
import { ensureInitialized } from '@/lib/init'
import { CreateInvoiceSchema, CreateCreditNoteSchema } from '@/lib/api/schemas'
import type { EntityType, AccountingMethod, Invoice, CreditNote, InvoiceDocumentType } from '@/types'
import { createCreditNoteJournalEntry } from '@/lib/bookkeeping/invoice-entries'
import { cancelSchedulesForSource } from '@/lib/bookkeeping/accruals/service'
import { ensureInvoiceNumber } from '@/lib/invoices/ensure-invoice-number'
import { buildInvoiceWriteData } from '@/lib/invoices/build-invoice-write'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import type { Logger } from '@/lib/logger'

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

    const { data, error, count } = await query

    if (error) {
      log.error('failed to list invoices', error)
      return errorResponse(error, log, { requestId })
    }

    return NextResponse.json({ data, count })
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
        details: { pgCode: invoiceError.code, pgMessage: invoiceError.message },
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
        details: { pgCode: itemsError.code, pgMessage: itemsError.message },
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

    return NextResponse.json({ data: completeInvoice })
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
  // Non-blocking issues (e.g. partial accrual cancellation) surfaced to the
  // caller alongside the created credit note.
  const warnings: Array<{ code: string; message: string }> = []

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

  if (!['sent', 'paid', 'overdue'].includes(originalInvoice.status)) {
    return errorResponseFromCode('INVOICE_CREDIT_NOT_SENT', log, {
      requestId,
      details: { currentStatus: originalInvoice.status },
    })
  }

  const creditNoteNumber = `KR-${originalInvoice.invoice_number}`

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
      notes: input.reason || `Krediterar faktura ${originalInvoice.invoice_number}`,
      credited_invoice_id: input.credited_invoice_id,
      // Copy the original's dimension bag so the credit-note verifikat nets
      // against the same dimension cells in reports (dimensions PR7).
      default_dimensions: originalInvoice.default_dimensions ?? {},
      status: 'sent',
    })
    .select()
    .single()

  if (creditNoteError) {
    log.error('credit note insert failed', creditNoteError)
    return errorResponseFromCode('INVOICE_CREATE_INSERT_FAILED', log, {
      requestId,
      details: { pgCode: creditNoteError.code, pgMessage: creditNoteError.message },
    })
  }

  const creditNoteItems = (originalInvoice.items || []).map((item: { sort_order: number; line_type?: 'product' | 'text'; description: string; quantity: number; unit: string; unit_price: number; line_total: number; vat_rate?: number; vat_amount?: number; revenue_account?: string | null; article_id?: string | null; accrual_period_start?: string | null; accrual_period_end?: string | null; accrual_balance_account?: string | null; dimensions?: Record<string, string> }) => ({
    invoice_id: creditNote.id,
    sort_order: item.sort_order,
    line_type: item.line_type ?? 'product',
    description: item.description,
    quantity: -Math.abs(item.quantity),
    unit: item.unit,
    unit_price: item.unit_price,
    line_total: -Math.abs(item.line_total),
    vat_rate: item.vat_rate ?? 0,
    vat_amount: -(item.vat_amount ? Math.abs(item.vat_amount) : 0),
    // Carry the original's per-line revenue-account override so the reversal
    // hits the SAME account it originally credited (e.g. 3041, not the
    // VAT-derived 3001): otherwise the override account keeps a dangling
    // balance. article_id is preserved for the usage history.
    revenue_account: item.revenue_account ?? null,
    article_id: item.article_id ?? null,
    // Same reasoning for periodiserade lines: the credit-note verifikat must
    // reverse against the 29xx interim account the original credited, not the
    // revenue account. generatePerRateLines reads these fields to substitute.
    // No schedule is ever created for a credit note (only send/mark-sent
    // create schedules); the original's schedule is cancelled below.
    accrual_period_start: item.accrual_period_start ?? null,
    accrual_period_end: item.accrual_period_end ?? null,
    accrual_balance_account: item.accrual_balance_account ?? null,
    // Same reasoning as revenue_account: the reversal must carry the exact
    // per-item bag the original booked with (dimensions PR7).
    dimensions: item.dimensions ?? {},
  }))

  const { error: itemsError } = await supabase.from('invoice_items').insert(creditNoteItems)

  if (itemsError) {
    await supabase.from('invoices').delete().eq('id', creditNote.id)
    log.error('credit note items insert failed; rolled back', itemsError, {
      creditNoteId: creditNote.id,
    })
    return errorResponseFromCode('INVOICE_CREATE_ITEMS_FAILED', log, {
      requestId,
      details: { pgCode: itemsError.code, pgMessage: itemsError.message },
    })
  }

  await supabase
    .from('invoices')
    .update({ status: 'credited' })
    .eq('id', input.credited_invoice_id)

  const { data: completeCreditNote } = await supabase
    .from('invoices')
    .select('*, customer:customers(*), items:invoice_items(*)')
    .eq('id', creditNote.id)
    .single()

  const { data: creditNoteSettings } = await supabase
    .from('company_settings')
    .select('entity_type, accounting_method')
    .eq('company_id', companyId)
    .single()

  const entityType = (creditNoteSettings?.entity_type as EntityType) || 'enskild_firma'
  const accountingMethod = (creditNoteSettings?.accounting_method as AccountingMethod) || 'accrual'

  // Cash method skips: there's no original invoice JE to reverse, recognition
  // is deferred until refund.
  if (completeCreditNote && accountingMethod === 'accrual') {
    try {
      const journalEntry = await createCreditNoteJournalEntry(
        supabase,
        companyId,
        userId,
        completeCreditNote as Invoice,
        entityType,
        completeCreditNote.customer?.name,
      )
      if (journalEntry) {
        await supabase
          .from('invoices')
          .update({ journal_entry_id: journalEntry.id })
          .eq('id', creditNote.id)
      }
    } catch (err) {
      log.error('failed to create credit note journal entry', err as Error, {
        creditNoteId: creditNote.id,
      })
      // Non-blocking: credit note still exists.
    }

    // Periodisering interplay: cancel remaining months and storno posted
    // dissolutions so origin + dissolutions + stornos + credit net to zero on
    // both 29xx and 3xxx. Best-effort: never blocks the credit itself, but
    // partial reversals are surfaced as a response warning so the user knows
    // the schedule stayed active.
    try {
      const cancelResult = await cancelSchedulesForSource(
        supabase,
        companyId,
        userId,
        { invoiceId: input.credited_invoice_id },
        { reversalDate: creditNote.invoice_date },
      )
      if (cancelResult.failedReversals > 0) {
        warnings.push({
          code: 'ACCRUAL_CANCEL_PARTIAL',
          message:
            'Fakturan krediterades, men en eller flera periodiseringsverifikat ' +
            'kunde inte vändas. Periodiseringen är fortfarande aktiv: ' +
            'kontrollera under Bokföring → Periodiseringar.',
        })
      }
    } catch (err) {
      log.warn('failed to cancel accrual schedules for credited invoice', err as Error)
      warnings.push({
        code: 'ACCRUAL_CANCEL_PARTIAL',
        message:
          'Fakturan krediterades, men periodiseringarna kunde inte avslutas. ' +
          'Kontrollera under Bokföring → Periodiseringar.',
      })
    }

    await eventBus.emit({
      type: 'credit_note.created',
      payload: { creditNote: completeCreditNote as CreditNote, companyId, userId },
    })
  }

  return NextResponse.json({
    data: completeCreditNote,
    ...(warnings.length > 0 ? { warnings } : {}),
  })
}
