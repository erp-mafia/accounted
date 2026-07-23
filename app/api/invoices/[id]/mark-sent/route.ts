import { NextResponse } from 'next/server'
import { renderToBuffer } from '@react-pdf/renderer'
import { createInvoiceJournalEntry } from '@/lib/bookkeeping/invoice-entries'
import { booksInvoicesOnIssue } from '@/lib/bookkeeping/booking-mode'
import { createSchedulesForCustomerInvoice } from '@/lib/bookkeeping/accruals/from-invoices'
import { eventBus } from '@/lib/events'
import { ensureInvoiceNumber } from '@/lib/invoices/ensure-invoice-number'
import {
  creditNoteNeedsJournalEntry,
  issueCreditNote,
  type CreditNoteOriginalInvoice,
} from '@/lib/invoices/issue-credit-note'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { parseCustomIssuanceLines } from '@/lib/invoices/issuance-custom-lines'
import { recordManualInvoiceDelivery } from '@/lib/invoices/invoice-deliveries'
import { InvoicePDF } from '@/lib/invoices/pdf-template'
import { prepareInvoicePdfRender, buildSwishQrDataUrl } from '@/lib/invoices/pdf-render-helpers'
import { invoicePdfFilename } from '@/lib/invoices/pdf-filename'
import {
  hasRequiredInvoicePaymentAccount,
  invoiceRequiresPaymentAccount,
} from '@/lib/invoices/payment-accounts'
import { uploadDocument } from '@/lib/core/documents/document-service'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import type {
  AccountingMethod,
  CompanySettings,
  CreditNote,
  Customer,
  EntityType,
  Invoice,
  InvoiceItem,
} from '@/types'

ensureInitialized()

/**
 * POST /api/invoices/[id]/mark-sent
 *
 * Manually marks a draft invoice as sent (for invoices delivered outside the system).
 * Under faktureringsmetoden (accrual): creates the journal entry (Debit 1510, Credit 30xx/26xx).
 * Under kontantmetoden (cash): no journal entry; booking happens at payment.
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

  const invoiceCurrency = (invoice as Invoice).currency
  const paymentAccountRequired = invoiceRequiresPaymentAccount(invoice as Invoice)
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
  let originalInvoice: CreditNoteOriginalInvoice | undefined
  let originalInvoiceNumber: string | undefined

  if (invoice.credited_invoice_id) {
    const { data: original } = await supabase
      .from('invoices')
      .select('id, invoice_number, status, journal_entry_id, paid_at, paid_amount, total')
      .eq('id', invoice.credited_invoice_id)
      .eq('company_id', companyId)
      .single()

    if (!original) {
      return errorResponseFromCode('INVOICE_CREDIT_ORIGINAL_NOT_FOUND', log, { requestId })
    }

    originalInvoice = original as CreditNoteOriginalInvoice
    originalInvoiceNumber = original.invoice_number ?? undefined
  }

  const journalEntryRequired = originalInvoice
    ? creditNoteNeedsJournalEntry(accountingMethod, originalInvoice)
    : false
  const isRecovery = isCreditNote && invoice.status === 'sent'

  if (
    isRecovery &&
    originalInvoice?.status === 'credited' &&
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

  // Only create journal entries for real invoices (not proformas or delivery notes)
  const isRealInvoice = !invoice.document_type || invoice.document_type === 'invoice'
  let journalEntryId: string | null = null
  const partialFailures: Array<{ step: string; reason: string }> = []

  // Custom lines only apply where mark-sent books inline; elsewhere they are
  // deliberately ignored (documented in MarkInvoiceSentSchema). Log it so the
  // mismatch is visible in audit review instead of vanishing silently.
  if (
    customLines &&
    (isCreditNote || !isRealInvoice || !booksInvoicesOnIssue(settings as CompanySettings))
  ) {
    log.warn('mark-sent: custom lines ignored (not on accrual book-at-issue path)', {
      invoiceId: id,
      lineCount: customLines.length,
    })
  }

  if (isCreditNote && originalInvoice) {
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
    journalEntryId = issueResult.journalEntryId
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
  } else if (isRealInvoice && booksInvoicesOnIssue(settings as CompanySettings)) {
    // #967: deferred companies fall past this branch (mark-sent WITHOUT
    // booking); ekonomi books later via POST /api/invoices/[id]/book, like
    // under kontantmetoden.
    try {
      if (customLines) {
        // Audit trail: distinguish user-edited bookings from generated ones.
        log.info('mark-sent: booking user-edited custom lines', {
          invoiceId: id,
          userId: user.id,
          lineCount: customLines.length,
        })
      }
      const journalEntry = customLines
        ? await createInvoiceJournalEntry(
            supabase,
            companyId,
            user.id,
            invoice as Invoice,
            entityType,
            invoice.customer?.name,
            { customLines },
          )
        : await createInvoiceJournalEntry(
            supabase,
            companyId,
            user.id,
            invoice as Invoice,
            entityType,
            invoice.customer?.name,
          )
      if (journalEntry) {
        journalEntryId = journalEntry.id

        // Periodiserade lines: create schedules + catch-up dissolutions now
        // that the revenue entry exists. Failures are logged, never fatal:
        // the verifikat is committed. Skipped when the user edited the lines:
        // the generated 29xx deferral may no longer exist in what was booked,
        // and a schedule would then dissolve an interim balance that was
        // never credited. User-edited lines book exactly as reviewed.
        if (!customLines) {
          const accrual = await createSchedulesForCustomerInvoice(
            supabase,
            companyId,
            user.id,
            invoice as Invoice,
            (invoice.items as InvoiceItem[] | null) ?? [],
            journalEntry.id,
            entityType,
          )
          if (accrual.failed > 0) {
            log.error('accrual schedule creation failed on mark-sent', {
              failed: accrual.failed,
            })
            partialFailures.push({
              step: 'accrual_schedules',
              reason: `${accrual.failed} periodisering(ar) kunde inte skapas`,
            })
          }
        }

        const { error: linkError } = await supabase
          .from('invoices')
          .update({ journal_entry_id: journalEntry.id })
          .eq('id', id)
        if (linkError) {
          // Don't fail mark-sent: the verifikat committed; only the link
          // failed. But log it through the structured logger so it reaches log
          // aggregation/alerting: this write silently no-ops when the
          // journal_entry_id column is missing (it was absent in prod until the
          // 20260613100000 migration), which leaves mark-paid unable to detect
          // an already-booked sale.
          log.error('mark-sent: journal_entry_id link to invoice failed', linkError, {
            journalEntryId: journalEntry.id,
          })
          partialFailures.push({
            step: 'journal_link',
            reason: 'Verifikatet skapades men kunde inte kopplas till fakturan.',
          })
        }
      } else {
        partialFailures.push({
          step: 'journal_entry',
          reason: 'Ingen öppen bokföringsperiod hittades för fakturans datum.',
        })
      }
    } catch (err) {
      log.error('failed to create invoice journal entry on mark-sent', err as Error)
      partialFailures.push({
        step: 'journal_entry',
        reason: 'Fakturans verifikat kunde inte skapas.',
      })
    }
  }

  // Fail-closed only when inline booking was supposed to happen: deferred
  // (#967) and cash-method invoices are legitimately unbooked at this point.
  if (isRealInvoice && booksInvoicesOnIssue(settings as CompanySettings) && !isCreditNote && !journalEntryId) {
    if (statusFlipped) {
      const { error: rollbackError } = await supabase
        .from('invoices')
        .update({ status: 'draft' })
        .eq('id', id)
        .eq('company_id', companyId)
        .eq('status', 'sent')
        .is('journal_entry_id', null)
      if (rollbackError) log.error('failed to restore draft after mark-sent booking failure', rollbackError)
    }
    return errorResponseFromCode('INVOICE_MARK_SENT_BOOK_FAILED', log, { requestId })
  }

  if (partialFailures.some((failure) => failure.step === 'journal_link')) {
    return errorResponseFromCode('INVOICE_MARK_SENT_REPAIR_REQUIRED', log, {
      requestId,
      details: { failure_steps: ['journal_link'] },
    })
  }

  // Render and archive the PDF as underlag so it remains retrievable even if
  // the invoice row is later cancelled. Mirrors the send route.
  if (isRealInvoice) {
    try {
      const items = (invoice.items as InvoiceItem[] | null ?? []).slice().sort(
        (a, b) => a.sort_order - b.sort_order
      )

      // The DB status flip already happened above, but the in-memory `invoice`
      // is stale and still reads 'draft': override here so the archived
      // underlag isn't stamped "UTKAST: inte en giltig faktura".
      const renderableInvoice = { ...(invoice as Invoice), status: 'sent' as const }
      const { branding, company: renderCompany } = await prepareInvoicePdfRender(
        settings as CompanySettings,
        renderableInvoice.currency,
        { paymentAccountRequired },
      )
      const swishQrDataUrl = await buildSwishQrDataUrl(renderCompany, renderableInvoice)
      const pdfBuffer = await renderToBuffer(
        InvoicePDF({
          invoice: renderableInvoice,
          customer: invoice.customer as Customer,
          items,
          company: renderCompany,
          originalInvoiceNumber,
          branding,
          swishQrDataUrl,
        })
      )

      const filename = invoicePdfFilename({
        companyName: settings.company_name,
        customerName: (invoice.customer as Customer).name,
        invoiceNumber: invoice.invoice_number,
        invoiceId: invoice.id,
        invoiceDate: invoice.invoice_date,
        documentType: invoice.document_type,
        isCreditNote: !!invoice.credited_invoice_id,
      })

      const pdfArrayBuffer = new Uint8Array(pdfBuffer).buffer as ArrayBuffer
      await uploadDocument(supabase, user.id, companyId, {
        name: filename,
        buffer: pdfArrayBuffer,
        type: 'application/pdf',
      }, {
        upload_source: 'system',
        journal_entry_id: journalEntryId ?? undefined,
      })
    } catch (err) {
      log.error('failed to archive invoice PDF on mark-sent', err as Error)
      partialFailures.push({
        step: 'pdf_archive',
        reason: 'Fakturans PDF kunde inte arkiveras.',
      })
    }
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

  if (!isCreditNote) {
    await eventBus.emit({
      type: 'invoice.sent',
      payload: { invoice: { ...(invoice as Invoice), status: 'sent' }, companyId, userId: user.id },
    })
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
