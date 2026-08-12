import { renderToBuffer } from '@react-pdf/renderer'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createInvoiceJournalEntry } from '@/lib/bookkeeping/invoice-entries'
import { booksInvoicesOnIssue } from '@/lib/bookkeeping/booking-mode'
import { createSchedulesForCustomerInvoice } from '@/lib/bookkeeping/accruals/from-invoices'
import { eventBus } from '@/lib/events'
import { ensureInvoiceNumber } from '@/lib/invoices/ensure-invoice-number'
import type { CustomIssuanceLine } from '@/lib/invoices/issuance-custom-lines'
import { recordManualInvoiceDelivery } from '@/lib/invoices/invoice-deliveries'
import { InvoicePDF } from '@/lib/invoices/pdf-template'
import { prepareInvoicePdfRender, buildSwishQrDataUrl } from '@/lib/invoices/pdf-render-helpers'
import { invoicePdfFilename } from '@/lib/invoices/pdf-filename'
import {
  hasRequiredInvoicePaymentAccount,
  invoiceRequiresPaymentAccount,
} from '@/lib/invoices/payment-accounts'
import { uploadDocument } from '@/lib/core/documents/document-service'
import type { Logger } from '@/lib/logger'
import type {
  CompanySettings,
  Customer,
  EntityType,
  Invoice,
  InvoiceItem,
} from '@/types'

export interface IssuePartialFailure {
  step: string
  reason: string
}

/** Joined invoice row as the issuance flows fetch it. */
export type IssuableInvoice = Invoice & {
  customer?: (Customer & { name?: string }) | null
  items?: InvoiceItem[] | null
}

export type IssueAndBookResult =
  | {
      ok: true
      journalEntryId: string | null
      partialFailures: IssuePartialFailure[]
    }
  | { ok: false; errorCode: string; details?: Record<string, unknown> }

export interface IssueAndBookOptions {
  supabase: SupabaseClient
  companyId: string
  userId: string
  /**
   * The draft invoice (with customer + items joined). Never a credit note:
   * credit-note issuance lives in issue-credit-note.ts and stays on the
   * mark-sent route.
   */
  invoice: IssuableInvoice
  settings: CompanySettings
  log: Logger
  /**
   * User-edited journal lines from the mark-sent body. Bulk paths pass none:
   * generated lines book as-is.
   */
  customLines?: CustomIssuanceLine[] | null
}

/**
 * Archive the issued invoice's PDF as underlag so it remains retrievable even
 * if the invoice row is later cancelled. Shared between the mark-sent route
 * (real invoices and credit notes) and the bulk Bokför flow. Returns a partial
 * failure instead of throwing: the issuance itself already committed.
 */
export async function archiveIssuedInvoicePdf(args: {
  supabase: SupabaseClient
  companyId: string
  userId: string
  invoice: IssuableInvoice
  settings: CompanySettings
  journalEntryId: string | null
  originalInvoiceNumber?: string
  log: Logger
}): Promise<IssuePartialFailure | null> {
  const { supabase, companyId, userId, invoice, settings, journalEntryId, log } = args
  try {
    const items = ((invoice.items as InvoiceItem[] | null) ?? [])
      .slice()
      .sort((a, b) => a.sort_order - b.sort_order)

    // The DB status flip already happened, but the in-memory `invoice` is
    // stale and still reads 'draft': override here so the archived underlag
    // isn't stamped "UTKAST: inte en giltig faktura".
    const renderableInvoice = { ...(invoice as Invoice), status: 'sent' as const }
    const paymentAccountRequired = invoiceRequiresPaymentAccount(invoice as Invoice)
    const { branding, company: renderCompany } = await prepareInvoicePdfRender(
      settings,
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
        originalInvoiceNumber: args.originalInvoiceNumber,
        branding,
        swishQrDataUrl,
      }),
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
    await uploadDocument(
      supabase,
      userId,
      companyId,
      {
        name: filename,
        buffer: pdfArrayBuffer,
        type: 'application/pdf',
      },
      {
        upload_source: 'system',
        journal_entry_id: journalEntryId ?? undefined,
      },
    )
    return null
  } catch (err) {
    log.error('failed to archive invoice PDF on mark-sent', err as Error)
    return {
      step: 'pdf_archive',
      reason: 'Fakturans PDF kunde inte arkiveras.',
    }
  }
}

/**
 * Issue a draft invoice without sending an email: assign the F-number, flip
 * the status to 'sent', and (under faktureringsmetoden with inline booking)
 * create and link the revenue verifikat. Exactly the mark-sent semantics for
 * a non-credit-note invoice; used by both POST /api/invoices/[id]/mark-sent
 * and POST /api/invoices/bulk-book so the two can never drift apart.
 *
 * Under kontantmetoden or deferred booking (#967) the invoice is marked sent
 * without a journal entry, matching mark-sent.
 */
export async function issueAndBookInvoice(
  opts: IssueAndBookOptions,
): Promise<IssueAndBookResult> {
  const { supabase, companyId, userId, invoice, settings, log } = opts
  const customLines = opts.customLines ?? null
  const id = invoice.id

  if (!hasRequiredInvoicePaymentAccount(settings, invoice as Invoice)) {
    return {
      ok: false,
      errorCode: 'INVOICE_SEND_PAYMENT_ACCOUNT_MISSING',
      details: { currency: (invoice as Invoice).currency },
    }
  }

  // Assign the number only after all payment-instruction guards pass.
  try {
    await ensureInvoiceNumber(supabase, companyId, invoice as Invoice)
  } catch (err) {
    log.error('failed to assign invoice number on mark-sent', err as Error)
    return { ok: false, errorCode: 'INVOICE_CREATE_NUMBER_ASSIGN_FAILED' }
  }

  const entityType = (settings.entity_type as EntityType) || 'enskild_firma'

  // Compare-and-set prevents two concurrent requests from posting two journal
  // entries for the same draft.
  const { data: updatedRows, error: updateError } = await supabase
    .from('invoices')
    .update({ status: 'sent' })
    .eq('id', id)
    .eq('company_id', companyId)
    .eq('status', 'draft')
    .select('id')

  if (updateError) {
    log.error('invoice mark-sent status update failed', updateError)
    return { ok: false, errorCode: 'INVOICE_MARK_SENT_STATUS_FAILED' }
  }
  if (!updatedRows || updatedRows.length === 0) {
    return { ok: false, errorCode: 'INVOICE_MARK_SENT_RACE' }
  }

  // Only create journal entries for real invoices (not proformas or delivery notes)
  const isRealInvoice = !invoice.document_type || invoice.document_type === 'invoice'
  let journalEntryId: string | null = null
  const partialFailures: IssuePartialFailure[] = []

  // Custom lines only apply where issuance books inline; elsewhere they are
  // deliberately ignored (documented in MarkInvoiceSentSchema). Log it so the
  // mismatch is visible in audit review instead of vanishing silently.
  if (customLines && (!isRealInvoice || !booksInvoicesOnIssue(settings))) {
    log.warn('mark-sent: custom lines ignored (not on accrual book-at-issue path)', {
      invoiceId: id,
      lineCount: customLines.length,
    })
  }

  if (isRealInvoice && booksInvoicesOnIssue(settings)) {
    // #967: deferred companies fall past this branch (mark sent WITHOUT
    // booking); ekonomi books later via POST /api/invoices/[id]/book, like
    // under kontantmetoden.
    try {
      if (customLines) {
        // Audit trail: distinguish user-edited bookings from generated ones.
        log.info('mark-sent: booking user-edited custom lines', {
          invoiceId: id,
          userId,
          lineCount: customLines.length,
        })
      }
      const journalEntry = customLines
        ? await createInvoiceJournalEntry(
            supabase,
            companyId,
            userId,
            invoice as Invoice,
            entityType,
            invoice.customer?.name,
            { customLines },
          )
        : await createInvoiceJournalEntry(
            supabase,
            companyId,
            userId,
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
            userId,
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
          // Don't fail the issuance: the verifikat committed; only the link
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
  if (isRealInvoice && booksInvoicesOnIssue(settings) && !journalEntryId) {
    const { error: rollbackError } = await supabase
      .from('invoices')
      .update({ status: 'draft' })
      .eq('id', id)
      .eq('company_id', companyId)
      .eq('status', 'sent')
      .is('journal_entry_id', null)
    if (rollbackError) {
      log.error('failed to restore draft after mark-sent booking failure', rollbackError)
    }
    return { ok: false, errorCode: 'INVOICE_MARK_SENT_BOOK_FAILED' }
  }

  if (partialFailures.some((failure) => failure.step === 'journal_link')) {
    return {
      ok: false,
      errorCode: 'INVOICE_MARK_SENT_REPAIR_REQUIRED',
      details: { failure_steps: ['journal_link'] },
    }
  }

  // Render and archive the PDF as underlag so it remains retrievable even if
  // the invoice row is later cancelled. Mirrors the send route.
  if (isRealInvoice) {
    const pdfFailure = await archiveIssuedInvoicePdf({
      supabase,
      companyId,
      userId,
      invoice,
      settings,
      journalEntryId,
      log,
    })
    if (pdfFailure) partialFailures.push(pdfFailure)
  }

  try {
    await recordManualInvoiceDelivery({
      supabase,
      companyId,
      userId,
      invoiceId: id,
    })
  } catch (err) {
    log.error('failed to record manual invoice delivery', err as Error)
    partialFailures.push({
      step: 'delivery_history',
      reason: 'Utskicket kunde inte sparas i fakturans historik.',
    })
  }

  await eventBus.emit({
    type: 'invoice.sent',
    payload: { invoice: { ...(invoice as Invoice), status: 'sent' }, companyId, userId },
  })

  return { ok: true, journalEntryId, partialFailures }
}
