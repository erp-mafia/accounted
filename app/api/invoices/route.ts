import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { eventBus } from '@/lib/events'
import { ensureInitialized } from '@/lib/init'
import { CreateInvoiceSchema, CreateCreditNoteSchema } from '@/lib/api/schemas'
import type { EntityType, AccountingMethod, Invoice, CreditNote, InvoiceDocumentType } from '@/types'
import { getVatRules, getAvailableVatRates } from '@/lib/invoices/vat-rules'
import { fetchExchangeRate, convertToSEK } from '@/lib/currency/riksbanken'
import { createCreditNoteJournalEntry } from '@/lib/bookkeeping/invoice-entries'
import { ensureInvoiceNumber } from '@/lib/invoices/ensure-invoice-number'
import {
  computeDeduction,
  computeInvoiceDeductionTotal,
  validateInvoice as validateRotRut,
} from '@/lib/invoices/rot-rut-rules'
import {
  encryptPersonnummer,
  extractLast4,
  validatePersonnummer,
} from '@/lib/salary/personnummer'
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

    // A non-VAT-registered seller may not charge output VAT (ML 1 kap. 1§).
    // We pull vat_registered from company_settings and feed it into the rule
    // helpers so the allowed-rates set collapses to {0} and any non-zero rate
    // submitted from the client fails INVOICE_CREATE_VAT_RULE_VIOLATION below.
    // Default to true when the settings row is absent or the column is NULL
    // — matches the prior implicit behavior (getVatRules' own default) so a
    // missing settings row never silently blocks legitimate VAT invoices.
    const { data: companySettings } = await supabase
      .from('company_settings')
      .select('vat_registered')
      .eq('company_id', companyId!)
      .single()
    const vatRegistered = companySettings?.vat_registered ?? true

    const vatRules = getVatRules(customer.customer_type, customer.vat_number_validated, vatRegistered)
    const availableRates = getAvailableVatRates(customer.customer_type, customer.vat_number_validated, vatRegistered)
    const allowedRates = new Set(availableRates.map((r) => r.rate))

    const subtotal = invoiceInput.items.reduce((sum, item) => sum + item.quantity * item.unit_price, 0)

    let vatAmount = 0
    if (documentType !== 'delivery_note') {
      for (const item of invoiceInput.items) {
        const itemRate = item.vat_rate !== undefined ? item.vat_rate : vatRules.rate
        if (!allowedRates.has(itemRate)) {
          return errorResponseFromCode('INVOICE_CREATE_VAT_RULE_VIOLATION', log, {
            requestId,
            details: {
              attemptedRate: itemRate,
              allowedRates: Array.from(allowedRates),
              customerType: customer.customer_type,
            },
          })
        }
        const lineTotal = item.quantity * item.unit_price
        vatAmount += Math.round(lineTotal * itemRate / 100 * 100) / 100
      }
    }
    const total = documentType === 'delivery_note' ? 0 : subtotal + vatAmount

    // ROT/RUT-avdrag: validate prerequisites and compute the per-item +
    // invoice-level deduction. Computed server-side (never trusted from
    // the client) so a tampered request can't expand the 1513 receivable.
    // Skipped entirely for proformas, delivery notes, and quotes — those
    // documents don't post journal entries and have no deduction model.
    let deductionTotal = 0
    let deductionPersonnummerEncrypted: string | null = null
    let deductionPersonnummerLast4: string | null = null
    if (documentType === 'invoice') {
      const housingProvided = !!invoiceInput.deduction_housing_designation?.trim()
      const personnummerRaw = invoiceInput.deduction_personnummer?.trim() || ''
      const personnummerProvided = personnummerRaw.length > 0

      const validateInput = invoiceInput.items.map((item) => ({
        unit_price: item.unit_price,
        quantity: item.quantity,
        deduction_type: item.deduction_type ?? null,
        labor_hours: item.labor_hours ?? null,
        housing_designation: item.housing_designation ?? null,
      }))
      const validation = validateRotRut(validateInput, personnummerProvided, housingProvided)
      if (validation.errors.length > 0) {
        return errorResponseFromCode('INVOICE_CREATE_ROT_RUT_VALIDATION', log, {
          requestId,
          details: { errors: validation.errors, warnings: validation.warnings },
        })
      }

      // Compute and (when present) encrypt the personnummer. The plaintext
      // value never touches the DB — only the AES-256-GCM ciphertext + the
      // last four digits go into invoices columns.
      deductionTotal = computeInvoiceDeductionTotal(validateInput)
      if (personnummerProvided) {
        const pnValid = validatePersonnummer(personnummerRaw)
        if (!pnValid.valid) {
          return errorResponseFromCode('INVOICE_CREATE_ROT_RUT_PERSONNUMMER_INVALID', log, {
            requestId,
            details: { error: pnValid.error },
          })
        }
        deductionPersonnummerEncrypted = encryptPersonnummer(personnummerRaw)
        deductionPersonnummerLast4 = extractLast4(personnummerRaw)
      }
    }

    const uniqueRates = new Set(invoiceInput.items.map((item) => item.vat_rate ?? vatRules.rate))
    const isMixedRate = uniqueRates.size > 1

    let exchangeRate: number | null = null
    let exchangeRateDate: string | null = null
    let subtotalSek: number | null = null
    let vatAmountSek: number | null = null
    let totalSek: number | null = null

    if (invoiceInput.currency !== 'SEK') {
      const rateData = await fetchExchangeRate(invoiceInput.currency)
      if (rateData) {
        exchangeRate = rateData.rate
        exchangeRateDate = rateData.date
        subtotalSek = convertToSEK(subtotal, exchangeRate)
        vatAmountSek = convertToSEK(vatAmount, exchangeRate)
        totalSek = convertToSEK(total, exchangeRate)
      }
    }

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
        customer_id: invoiceInput.customer_id,
        invoice_number: invoiceNumber,
        invoice_date: invoiceInput.invoice_date,
        due_date: invoiceInput.due_date,
        delivery_date: invoiceInput.delivery_date ?? null,
        currency: invoiceInput.currency,
        exchange_rate: exchangeRate,
        exchange_rate_date: exchangeRateDate,
        subtotal: documentType === 'delivery_note' ? 0 : subtotal,
        subtotal_sek: documentType === 'delivery_note' ? null : subtotalSek,
        vat_amount: vatAmount,
        vat_amount_sek: documentType === 'delivery_note' ? null : vatAmountSek,
        total,
        total_sek: documentType === 'delivery_note' ? null : totalSek,
        // Initialize remaining_amount to total - deduction for real invoices
        // so the open-invoice queries (InvoicePicker, AR ledger, supplier
        // matching) treat newly-created invoices as fully unpaid for the
        // CUSTOMER's share — the Skatteverket portion is on 1513 and will be
        // cleared when the agency pays out, not by the customer payment.
        // Proformas, delivery notes and quotes have no payment obligation,
        // so they keep the 0 default.
        remaining_amount: documentType === 'invoice' ? total - deductionTotal : 0,
        vat_treatment: vatRules.treatment,
        vat_rate: documentType === 'delivery_note' ? 0 : (isMixedRate ? null : (uniqueRates.values().next().value ?? vatRules.rate)),
        moms_ruta: vatRules.momsRuta,
        reverse_charge_text: vatRules.reverseChargeText || null,
        your_reference: invoiceInput.your_reference,
        our_reference: invoiceInput.our_reference,
        notes: invoiceInput.notes,
        document_type: documentType,
        deduction_total: deductionTotal,
        deduction_personnummer_encrypted: deductionPersonnummerEncrypted,
        deduction_personnummer_last4: deductionPersonnummerLast4,
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

    const items = invoiceInput.items.map((item, index) => {
      const itemRate = item.vat_rate !== undefined ? item.vat_rate : vatRules.rate
      const lineTotal = item.quantity * item.unit_price
      const itemVat = documentType === 'delivery_note' ? 0 : Math.round(lineTotal * itemRate / 100 * 100) / 100
      // ROT/RUT deduction is recomputed server-side so a tampered client
      // can't expand the 1513 receivable beyond the rules. Non-invoice
      // document types never carry deduction_type (rules above strip them
      // implicitly because validateRotRut isn't invoked).
      const deductionType = documentType === 'invoice' ? (item.deduction_type ?? null) : null
      const deductionAmount = deductionType
        ? computeDeduction({
            unit_price: item.unit_price,
            quantity: item.quantity,
            deduction_type: deductionType,
          })
        : 0
      return {
        invoice_id: invoice.id,
        sort_order: index,
        description: item.description,
        quantity: item.quantity,
        unit: item.unit,
        unit_price: item.unit_price,
        line_total: lineTotal,
        vat_rate: itemRate,
        vat_amount: itemVat,
        deduction_type: deductionType,
        deduction_amount: deductionAmount,
        labor_hours: documentType === 'invoice' ? (item.labor_hours ?? null) : null,
        work_type: documentType === 'invoice' ? (item.work_type ?? null) : null,
        housing_designation: documentType === 'invoice' ? (item.housing_designation ?? null) : null,
        apartment_number: documentType === 'invoice' ? (item.apartment_number ?? null) : null,
      }
    })

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

    // Allocate F-series number on save (Fortnox-style). The user gets a numbered
    // draft they can download and send manually without first lying about
    // having sent it. Discarded numbered drafts become 'cancelled' rather than
    // deleted, so the F-series stays gap-free per ML 17 kap 24§.
    // Delivery notes already have their number from the insert above.
    if (documentType === 'invoice' || documentType === 'proforma') {
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
        // Guard on status='draft' for symmetry with the DELETE handler — only
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

    // Emit event only for real invoices (proformas / delivery notes / quotes are informational).
    if (completeInvoice && documentType === 'invoice') {
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

  const creditNoteItems = (originalInvoice.items || []).map((item: { sort_order: number; description: string; quantity: number; unit: string; unit_price: number; line_total: number; vat_rate?: number; vat_amount?: number }) => ({
    invoice_id: creditNote.id,
    sort_order: item.sort_order,
    description: item.description,
    quantity: -Math.abs(item.quantity),
    unit: item.unit,
    unit_price: item.unit_price,
    line_total: -Math.abs(item.line_total),
    vat_rate: item.vat_rate ?? 0,
    vat_amount: -(item.vat_amount ? Math.abs(item.vat_amount) : 0),
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

  // Cash method skips: there's no original invoice JE to reverse — recognition
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
      // Non-blocking — credit note still exists.
    }

    await eventBus.emit({
      type: 'credit_note.created',
      payload: { creditNote: completeCreditNote as CreditNote, companyId, userId },
    })
  }

  return NextResponse.json({ data: completeCreditNote })
}
