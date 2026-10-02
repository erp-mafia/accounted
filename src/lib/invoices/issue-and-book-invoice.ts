import { resolveCompanyEntityType } from '@/lib/company/entity-type'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createInvoiceJournalEntry } from '@/lib/bookkeeping/invoice-entries'
import { booksInvoicesOnIssue } from '@/lib/bookkeeping/booking-mode'
import { createSchedulesForCustomerInvoice } from '@/lib/bookkeeping/accruals/from-invoices'
import { eventBus } from '@/lib/events'
import { ensureInvoiceNumber } from '@/lib/invoices/ensure-invoice-number'
import type { CustomIssuanceLine } from '@/lib/invoices/issuance-custom-lines'
import { recordManualInvoiceDelivery } from '@/lib/invoices/invoice-deliveries'
import { renderInvoicePdfBuffer } from '@/lib/invoices/render-invoice-pdf'
import { snapshotInvoicePayee } from '@/lib/invoices/invoice-payee'
import { invoicePdfFilename } from '@/lib/invoices/pdf-filename'
import {
  hasRequiredInvoicePaymentAccount,
  invoiceRequiresPaymentAccount,
} from '@/lib/invoices/payment-accounts'
import { hasRequiredSellerVatNumber } from '@/lib/invoices/seller-vat-number'
import { invoiceLacksCustomer } from '@/lib/invoices/invoice-customer'
import { uploadDocument } from '@/lib/core/documents/document-service'
import { getErrorMessage } from '@/lib/errors/get-error-message'
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
    // isn't stamped "UTKAST".
    const renderableInvoice = { ...(invoice as Invoice), status: 'sent' as const }
    // The same render entry point as the send route, so the archived
    // underlag carries the same QR code as the document the customer holds
    // (and the preview): it used to archive no payment-link code at all.
    const { buffer: pdfBuffer } = await renderInvoicePdfBuffer({
      invoice: renderableInvoice,
      customer: invoice.customer as Customer,
      items,
      company: settings,
      originalInvoiceNumber: args.originalInvoiceNumber,
      paymentAccountRequired: invoiceRequiresPaymentAccount(invoice as Invoice),
    })

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

export type MarkSentAndBookResult =
  | {
      ok: true
      journalEntryId: string | null
      partialFailures: IssuePartialFailure[]
    }
  | {
      ok: false
      errorCode:
        | 'INVOICE_MARK_SENT_STATUS_FAILED'
        | 'INVOICE_MARK_SENT_RACE'
        | 'INVOICE_MARK_SENT_BOOK_FAILED'
        | 'INVOICE_CUSTOMER_MISSING'
      /**
       * INVOICE_MARK_SENT_BOOK_FAILED only: why no verifikat was posted, in
       * Swedish (the engine's refusal, such as a required dimension or an
       * archived dimension value, or no open fiscal period for the date), so
       * the caller can show it where the user can fix it.
       */
      reason?: string
      /** INVOICE_MARK_SENT_BOOK_FAILED only: the engine's thrown refusal. */
      bookingError?: unknown
    }

/**
 * The issue step every path runs BEFORE an invoice reaches anyone: compare-
 * and-set the numbered draft to 'sent', then (a real invoice that books at
 * issue under faktureringsmetoden) post and link its revenue verifikat.
 *
 * Fail closed: when the verifikat is not posted, the status goes back to
 * draft and the result is ok:false, so no caller delivers, or reports as
 * sent, an invoice the ledger does not have. Callers deliver only after
 * ok:true: mark-sent and bulk Bokför (issueAndBookInvoice below), the email
 * send route and the recurring auto-send. Deferred booking (#967) and
 * kontantmetoden flip the status without a verifikat, as mark-sent always
 * has. The compare-and-set is also the single-winner lock: of two concurrent
 * issuers only one gets past it, so the verifikat is never posted twice.
 */
export async function markInvoiceSentAndBook(
  opts: IssueAndBookOptions,
): Promise<MarkSentAndBookResult> {
  const { supabase, companyId, userId, invoice, settings, log } = opts
  const customLines = opts.customLines ?? null
  const id = invoice.id

  // No buyer, no invoice (crm#263): a draft whose customer was deleted is
  // never issued, whichever path tries. Checked before the status flip, so
  // nothing has changed when it refuses.
  if (invoiceLacksCustomer(invoice)) {
    return { ok: false, errorCode: 'INVOICE_CUSTOMER_MISSING' }
  }

  const entityType = await resolveCompanyEntityType(supabase, companyId, settings.entity_type)

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
    log.error('invoice status update to sent failed', updateError)
    return { ok: false, errorCode: 'INVOICE_MARK_SENT_STATUS_FAILED' }
  }
  if (!updatedRows || updatedRows.length === 0) {
    return { ok: false, errorCode: 'INVOICE_MARK_SENT_RACE' }
  }

  // Only create journal entries for real invoices (not proformas or delivery notes)
  const isRealInvoice = !invoice.document_type || invoice.document_type === 'invoice'
  let journalEntryId: string | null = null
  const partialFailures: IssuePartialFailure[] = []
  let bookingReason = 'Fakturans verifikat kunde inte skapas.'
  let bookingError: unknown

  // Custom lines only apply where issuance books inline; elsewhere they are
  // deliberately ignored (documented in MarkInvoiceSentSchema). Log it so the
  // mismatch is visible in audit review instead of vanishing silently.
  if (customLines && (!isRealInvoice || !booksInvoicesOnIssue(settings))) {
    log.warn('issue: custom lines ignored (not on accrual book-at-issue path)', {
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
        log.info('issue: booking user-edited custom lines', {
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
            log.error('accrual schedule creation failed on issue', {
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
          log.error('issue: journal_entry_id link to invoice failed', linkError, {
            journalEntryId: journalEntry.id,
          })
          partialFailures.push({
            step: 'journal_link',
            reason: 'Verifikatet skapades men kunde inte kopplas till fakturan.',
          })
        }
      } else {
        bookingReason = 'Ingen öppen bokföringsperiod hittades för fakturans datum.'
      }
    } catch (err) {
      log.error('failed to create invoice journal entry on issue', err as Error)
      bookingError = err
      bookingReason = getErrorMessage(err)
    }
  }

  // Fail-closed only when inline booking was supposed to happen: deferred
  // (#967) and cash-method invoices are legitimately unbooked at this point.
  if (isRealInvoice && booksInvoicesOnIssue(settings) && !journalEntryId) {
    await restoreUnbookedDraft(supabase, companyId, id, log)
    return {
      ok: false,
      errorCode: 'INVOICE_MARK_SENT_BOOK_FAILED',
      reason: bookingReason,
      ...(bookingError !== undefined ? { bookingError } : {}),
    }
  }

  return { ok: true, journalEntryId, partialFailures }
}

/**
 * Put an issued invoice back to draft when nothing is booked for it: the
 * compare-and-set only matches status 'sent' with no journal_entry_id, so it
 * can never strand a posted verifikat. Used when the verifikat was refused
 * (above) and when an email to an invoice that books nothing at issue
 * (kontantmetoden, deferred booking, a proforma) failed: nothing irreversible
 * happened, so the send can simply be retried. Returns whether the draft was
 * restored.
 */
export async function restoreUnbookedDraft(
  supabase: SupabaseClient,
  companyId: string,
  invoiceId: string,
  log: Logger,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('invoices')
    .update({ status: 'draft' })
    .eq('id', invoiceId)
    .eq('company_id', companyId)
    .eq('status', 'sent')
    .is('journal_entry_id', null)
    .select('id')
  if (error) {
    log.error('failed to restore the draft of an unbooked invoice', error)
    return false
  }
  return Array.isArray(data) && data.length > 0
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
  const { supabase, companyId, invoice, settings, log } = opts

  // Before the number below is taken: a draft without a customer (crm#263)
  // is refused while it is still unnumbered and deletable.
  if (invoiceLacksCustomer(invoice)) {
    return { ok: false, errorCode: 'INVOICE_CUSTOMER_MISSING' }
  }

  // An invoice that chose a bank account freezes that account's payee now,
  // from the account as it is at issue; a chosen account that can no longer
  // be used blocks issue instead of silently printing the company default.
  const payeeSnapshot = await snapshotInvoicePayee(supabase, companyId, invoice as Invoice)
  if (!payeeSnapshot.ok) {
    return { ok: false, errorCode: payeeSnapshot.code, details: payeeSnapshot.details }
  }
  ;(invoice as Invoice).payment_details = payeeSnapshot.payee

  if (!hasRequiredInvoicePaymentAccount(settings, invoice as Invoice)) {
    return {
      ok: false,
      errorCode: 'INVOICE_SEND_PAYMENT_ACCOUNT_MISSING',
      details: { currency: (invoice as Invoice).currency },
    }
  }

  if (!hasRequiredSellerVatNumber(settings, invoice as Invoice)) {
    return { ok: false, errorCode: 'INVOICE_SEND_VAT_NUMBER_MISSING' }
  }

  // Assign the number only after all payment-instruction guards pass.
  try {
    await ensureInvoiceNumber(supabase, companyId, invoice as Invoice)
  } catch (err) {
    log.error('failed to assign invoice number on mark-sent', err as Error)
    return { ok: false, errorCode: 'INVOICE_CREATE_NUMBER_ASSIGN_FAILED' }
  }

  const issued = await markInvoiceSentAndBook(opts)
  if (!issued.ok) return { ok: false, errorCode: issued.errorCode }
  const { journalEntryId, partialFailures } = issued

  if (partialFailures.some((failure) => failure.step === 'journal_link')) {
    return {
      ok: false,
      errorCode: 'INVOICE_MARK_SENT_REPAIR_REQUIRED',
      details: { failure_steps: ['journal_link'] },
    }
  }

  partialFailures.push(
    ...(await finishIssuedInvoice({ ...opts, journalEntryId, recordDelivery: true })),
  )
  return { ok: true, journalEntryId, partialFailures }
}

/**
 * The tail of an issue that went through: archive the PDF as underlag (so it
 * stays retrievable even if the invoice row is later cancelled), record the
 * delivery when the invoice was delivered outside Accounted's email
 * (mark-sent, Peppol), and emit invoice.sent. Also how a door finishes an
 * invoice that is issued and booked but whose own delivery failed (the
 * verifikat is never undone), then without the delivery record. Returns the
 * failed steps; the issue itself is already committed.
 */
export async function finishIssuedInvoice(
  opts: IssueAndBookOptions & { journalEntryId: string | null; recordDelivery: boolean },
): Promise<IssuePartialFailure[]> {
  const { supabase, companyId, userId, invoice, settings, log, journalEntryId } = opts
  const failures: IssuePartialFailure[] = []
  const isRealInvoice = !invoice.document_type || invoice.document_type === 'invoice'

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
    if (pdfFailure) failures.push(pdfFailure)
  }

  if (opts.recordDelivery) {
    try {
      await recordManualInvoiceDelivery({
        supabase,
        companyId,
        userId,
        invoiceId: invoice.id,
      })
    } catch (err) {
      log.error('failed to record manual invoice delivery', err as Error)
      failures.push({
        step: 'delivery_history',
        reason: 'Utskicket kunde inte sparas i fakturans historik.',
      })
    }
  }

  await eventBus.emit({
    type: 'invoice.sent',
    payload: { invoice: { ...(invoice as Invoice), status: 'sent' }, companyId, userId },
  })

  return failures
}
