import { NextResponse } from 'next/server'
import { ensureInvoiceNumber, invoiceNumberingFailure } from '@/lib/invoices/ensure-invoice-number'
import { issueAndBookInvoice } from '@/lib/invoices/issue-and-book-invoice'
import { issueCreditNoteDraft } from '@/lib/invoices/credit-invoice'
import { withRouteContext } from '@/lib/api/with-route-context'
import { parseCustomIssuanceLines } from '@/lib/invoices/issuance-custom-lines'
import { hasRequiredInvoicePaymentAccount } from '@/lib/invoices/payment-accounts'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import type {
  CompanySettings,
  CreditNote,
  Invoice,
} from '@/types'

/**
 * POST /api/invoices/[id]/mark-sent
 *
 * Manually marks a draft invoice as sent (for invoices delivered outside the system).
 * Under faktureringsmetoden (accrual): creates the journal entry (Debit 1510, Credit 30xx/26xx).
 * Under kontantmetoden (cash): no journal entry; booking happens at payment.
 *
 * The non-credit-note core lives in lib/invoices/issue-and-book-invoice.ts,
 * shared with POST /api/invoices/bulk-book; the credit-note issue step in
 * lib/invoices/credit-invoice.ts, shared with the v1 and MCP credit doors.
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
        ...(result.messageSv ? { messageSv: result.messageSv, messageEn: result.messageEn } : {}),
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
    const failure = invoiceNumberingFailure(err, 'INVOICE_CREATE_NUMBER_ASSIGN_FAILED')
    return errorResponseFromCode(failure.code, log, {
      requestId,
      messageSv: failure.messageSv,
      messageEn: failure.messageEn,
      details: failure.details,
    })
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

  // The issue step every credit door shares (lib/invoices/credit-invoice.ts):
  // compare-and-set to sent, the reversing verifikat and the original's flip,
  // the draft restored when no verifikat could be posted, the PDF archived.
  const issued = await issueCreditNoteDraft({
    supabase,
    companyId,
    userId: user.id,
    creditNote: invoice as CreditNote,
    settings: settings as CompanySettings,
    log,
    recordDelivery: true,
  })
  if (!issued.ok) {
    return errorResponseFromCode(issued.code, log, {
      requestId,
      ...(issued.details ? { details: issued.details } : {}),
    })
  }
  const { journalEntryId, partialFailures } = issued

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
