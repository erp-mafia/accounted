import { NextResponse } from 'next/server'
import { ensureInvoiceNumber } from '@/lib/invoices/ensure-invoice-number'
import {
  creditNoteNeedsJournalEntry,
  issueCreditNote,
  type CreditNoteOriginalInvoice,
} from '@/lib/invoices/issue-credit-note'
import {
  archiveIssuedInvoicePdf,
  issueAndBookInvoice,
  type IssuePartialFailure,
} from '@/lib/invoices/issue-and-book-invoice'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { parseCustomIssuanceLines } from '@/lib/invoices/issuance-custom-lines'
import { recordManualInvoiceDelivery } from '@/lib/invoices/invoice-deliveries'
import { hasRequiredInvoicePaymentAccount } from '@/lib/invoices/payment-accounts'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import type {
  AccountingMethod,
  CompanySettings,
  CreditNote,
  EntityType,
  Invoice,
} from '@/types'

ensureInitialized()

/**
 * POST /api/invoices/[id]/mark-sent
 *
 * Manually marks a draft invoice as sent (for invoices delivered outside the system).
 * Under faktureringsmetoden (accrual): creates the journal entry (Debit 1510, Credit 30xx/26xx).
 * Under kontantmetoden (cash): no journal entry; booking happens at payment.
 *
 * The non-credit-note core lives in lib/invoices/issue-and-book-invoice.ts,
 * shared with POST /api/invoices/bulk-book; credit notes stay inline here.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'invoice.mark_sent',
  async (request, { supabase, user, companyId, log, requestId }, { params }) => {
  const { id } = await params

  // Optional body. Backwards-compat: callers may POST with no body. Read it
  // here but validate only AFTER the ownership fetch below, so callers never
  // get payload feedback for invoices outside their company.
  let rawBody: unknown
  const bodyText = await request.text()
  if (bodyText) {
    try {
      rawBody = JSON.parse(bodyText)
    } catch {
      // Malformed JSON must not silently fall back to generated lines.
      return NextResponse.json({ error: 'Ogiltig förfrågan' }, { status: 400 })
    }
  }

  // Fetch invoice
  const { data: invoice, error: invoiceError } = await supabase
    .from('invoices')
    .select('*, customer:customers(*), items:invoice_items(*)')
    .eq('id', id)
    .eq('company_id', companyId)
    .single()

  if (invoiceError || !invoice) {
    return errorResponseFromCode('INVOICE_NOT_FOUND', log, { requestId })
  }

  const isCreditNote = !!invoice.credited_invoice_id

  if (!isCreditNote && invoice.status !== 'draft') {
    return errorResponseFromCode('INVOICE_MARK_SENT_INVALID_STATUS', log, { requestId })
  }
  if (isCreditNote && !['draft', 'sent'].includes(invoice.status)) {
    return errorResponseFromCode('INVOICE_MARK_SENT_INVALID_STATUS', log, { requestId })
  }

  const linesResult = parseCustomIssuanceLines(rawBody)
  if (!linesResult.ok) {
    if (linesResult.error === 'invalid_body') {
      log.warn('mark-sent validation failed', { invoiceId: id })
      return NextResponse.json(
        { error: 'Ogiltig förfrågan', details: linesResult.details },
        { status: 400 },
      )
    }
    return errorResponseFromCode(
      linesResult.error === 'unbalanced'
        ? 'INVOICE_MARK_SENT_LINES_UNBALANCED'
        : 'INVOICE_MARK_SENT_LINES_INVALID',
      log,
      { requestId, details: linesResult.details },
    )
  }
  const customLines = linesResult.lines

  // Fetch full company settings for PDF rendering and accounting method
  const { data: settings, error: settingsError } = await supabase
    .from('company_settings')
    .select('*')
    .eq('company_id', companyId)
    .single()

  if (settingsError || !settings) {
    return errorResponseFromCode('INVOICE_SEND_COMPANY_SETTINGS_MISSING', log, { requestId })
  }

  if (!isCreditNote) {
    const result = await issueAndBookInvoice({
      supabase,
      companyId,
      userId: user.id,
      invoice: invoice as Invoice,
      settings: settings as CompanySettings,
      log,
      customLines,
    })

    if (!result.ok) {
      return errorResponseFromCode(result.errorCode, log, {
        requestId,
        ...(result.details ? { details: result.details } : {}),
      })
    }

    return NextResponse.json(
      {
        success: true,
        status: 'sent',
        journal_entry_id: result.journalEntryId,
        ...(result.partialFailures.length > 0
          ? { partial: true, partial_failures: result.partialFailures }
          : {}),
      },
      { headers: { 'Cache-Control': 'private, no-store' } },
    )
  }

  // ── Credit-note path ────────────────────────────────────────────────

  const invoiceCurrency = (invoice as Invoice).currency
  if (!hasRequiredInvoicePaymentAccount(settings as CompanySettings, invoice as Invoice)) {
    return errorResponseFromCode('INVOICE_SEND_PAYMENT_ACCOUNT_MISSING', log, {
      requestId,
      details: { currency: invoiceCurrency },
    })
  }

  // Assign the number only after all payment-instruction guards pass.
  try {
    await ensureInvoiceNumber(supabase, companyId, invoice as Invoice)
  } catch (err) {
    log.error('failed to assign invoice number on mark-sent', err as Error)
    return errorResponseFromCode('INVOICE_CREATE_NUMBER_ASSIGN_FAILED', log, { requestId })
  }

  const accountingMethod = (settings.accounting_method || 'accrual') as AccountingMethod
  const entityType = (settings.entity_type as EntityType) || 'enskild_firma'

  const { data: original } = await supabase
    .from('invoices')
    .select('id, invoice_number, external_invoice_number, status, journal_entry_id, paid_at, paid_amount, total')
    .eq('id', invoice.credited_invoice_id)
    .eq('company_id', companyId)
    .single()

  if (!original) {
    return errorResponseFromCode('INVOICE_CREDIT_ORIGINAL_NOT_FOUND', log, { requestId })
  }

  const originalInvoice = original as CreditNoteOriginalInvoice
  // Self-billed originals carry their number in external_invoice_number
  // (invoice_number is null by design); without the fallback the credit-note
  // PDF loses its ML 17 kap 22 reference to the original (issue #1820).
  const originalInvoiceNumber =
    original.invoice_number ?? original.external_invoice_number ?? undefined

  const journalEntryRequired = creditNoteNeedsJournalEntry(accountingMethod, originalInvoice)
  const isRecovery = invoice.status === 'sent'

  if (
    isRecovery &&
    originalInvoice.status === 'credited' &&
    (!journalEntryRequired || !!invoice.journal_entry_id)
  ) {
    return errorResponseFromCode('INVOICE_CREDIT_ALREADY_ISSUED', log, { requestId })
  }

  // Compare-and-set prevents two concurrent requests from posting two journal
  // entries for the same draft.
  let statusFlipped = false
  if (!isRecovery) {
    const { data: updatedRows, error: updateError } = await supabase
      .from('invoices')
      .update({ status: 'sent' })
      .eq('id', id)
      .eq('company_id', companyId)
      .eq('status', 'draft')
      .select('id')

    if (updateError) {
      log.error('invoice mark-sent status update failed', updateError)
      return errorResponseFromCode('INVOICE_MARK_SENT_STATUS_FAILED', log, { requestId })
    }
    if (!updatedRows || updatedRows.length === 0) {
      return errorResponseFromCode('INVOICE_MARK_SENT_RACE', log, { requestId })
    }
    statusFlipped = true
  }

  // Custom lines never apply to credit notes; log the mismatch so it stays
  // visible in audit review instead of vanishing silently (documented in
  // MarkInvoiceSentSchema).
  if (customLines) {
    log.warn('mark-sent: custom lines ignored (not on accrual book-at-issue path)', {
      invoiceId: id,
      lineCount: customLines.length,
    })
  }

  const partialFailures: IssuePartialFailure[] = []

  const issueResult = await issueCreditNote({
    supabase,
    companyId,
    userId: user.id,
    creditNote: invoice as CreditNote,
    originalInvoice,
    entityType,
    accountingMethod,
    log,
  })
  const journalEntryId = issueResult.journalEntryId
  partialFailures.push(...issueResult.failures)

  if (!issueResult.complete) {
    // If no immutable entry was created, restoring the draft is safe and
    // lets the user fix the period/account issue before trying again.
    if (statusFlipped && issueResult.journalEntryRequired && !issueResult.journalEntryId) {
      await supabase
        .from('invoices')
        .update({ status: 'draft' })
        .eq('id', id)
        .eq('company_id', companyId)
        .eq('status', 'sent')
        .is('journal_entry_id', null)
    }
    return errorResponseFromCode(
      issueResult.repairRequired
        ? 'INVOICE_CREDIT_REPAIR_REQUIRED'
        : 'INVOICE_CREDIT_ISSUE_INCOMPLETE',
      log,
      {
        requestId,
        details: { failure_steps: issueResult.failures.map((failure) => failure.step) },
      },
    )
  }

  // Render and archive the PDF as underlag so it remains retrievable even if
  // the invoice row is later cancelled. Credit notes are real invoices
  // (document_type 'invoice'), so this mirrors the non-credit path.
  const isRealInvoice = !invoice.document_type || invoice.document_type === 'invoice'
  if (isRealInvoice) {
    const pdfFailure = await archiveIssuedInvoicePdf({
      supabase,
      companyId,
      userId: user.id,
      invoice: invoice as Invoice,
      settings: settings as CompanySettings,
      journalEntryId,
      originalInvoiceNumber,
      log,
    })
    if (pdfFailure) partialFailures.push(pdfFailure)
  }

  if (statusFlipped) {
    try {
      await recordManualInvoiceDelivery({
        supabase,
        companyId,
        userId: user.id,
        invoiceId: id,
      })
    } catch (err) {
      log.error('failed to record manual invoice delivery', err as Error)
      partialFailures.push({
        step: 'delivery_history',
        reason: 'Utskicket kunde inte sparas i fakturans historik.',
      })
    }
  }

  return NextResponse.json(
    {
      success: true,
      status: 'sent',
      journal_entry_id: journalEntryId,
      ...(partialFailures.length > 0
        ? { partial: true, partial_failures: partialFailures }
        : {}),
    },
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
  },
  { requireWrite: true },
)
