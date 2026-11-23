import { resolveCompanyEntityType } from '@/lib/company/entity-type'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createInvoiceJournalEntry } from '@/lib/bookkeeping/invoice-entries'
import { issueBooksDocument } from '@/lib/bookkeeping/booking-mode'
import { isCreditNoteDocument } from '@/lib/bookkeeping/credit-note-state'
import {
  ACCRUAL_RELEASE_FAILED_WARNING,
  createSchedulesForCustomerInvoice,
} from '@/lib/bookkeeping/accruals/from-invoices'
import { emitInvoiceSent } from '@/lib/invoices/invoice-sent-event'
import { ensureInvoiceNumber, invoiceNumberingFailure } from '@/lib/invoices/ensure-invoice-number'
import type { CustomIssuanceLine } from '@/lib/invoices/issuance-custom-lines'
import { paidAtIssueBlockReason } from '@/lib/invoices/paid-at-issue'
import { settleInvoicePayment } from '@/lib/invoices/settle-invoice-payment'
import { recordManualInvoiceDelivery } from '@/lib/invoices/invoice-deliveries'
import { renderInvoicePdfBuffer } from '@/lib/invoices/render-invoice-pdf'
import { snapshotInvoicePayee } from '@/lib/invoices/invoice-payee'
import { invoicePdfFilename } from '@/lib/invoices/pdf-filename'
import {
  hasRequiredInvoicePaymentAccount,
  invoiceRequiresPaymentAccount,
} from '@/lib/cash-accounts/invoice-payment-accounts'
import { hasRequiredSellerVatNumber } from '@/lib/invoices/seller-vat-number'
import { invoicePartiesVerdict, type InvoicePartiesCustomer, type InvoicePartiesInvoice } from '@/lib/invoices/invoice-parties'
import { invoiceLacksCustomer } from '@/lib/invoices/invoice-customer'
import { uploadDocument } from '@/lib/core/documents/document-service'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { roundOre } from '@/lib/money'
import type { Logger } from '@/lib/logger'
import type {
  CompanySettings,
  Customer,
  EntityType,
  Invoice,
  InvoiceItem,
} from '@/types'
import { linkBasisColumns } from '@/lib/links/stamp'

export interface IssuePartialFailure {
  step: string
  reason: string
}

/** Joined invoice row as the issuance flows fetch it. */
export type IssuableInvoice = Invoice & {
  customer?: (Customer & { name?: string }) | null
  items?: InvoiceItem[] | null
}

/** Why a door refuses, as a code of the error registry. */
export interface IssueRefusal {
  code: string
  details?: Record<string, unknown>
}

/**
 * Whether this draft can be issued, the one answer of mark-sent, the email
 * send, bulk Bokför and the digital mailboxes. Each door asks before a number
 * is taken, and after the payee snapshot: the payment account reads the
 * frozen payee. A linked credit note has its own issue step, so a door routes
 * it there first (a door without one refuses it); what reaches this question
 * with a total below zero has no original to name (ML 17 kap 22 §).
 *
 * The seller's and the buyer's name and address (ML 17 kap 24 § p.5-6) are
 * read off the joined customer and the lines' deductions
 * (invoicePartiesVerdict): every door selects the customer with its address
 * columns and the items with deduction_type.
 */
export function issuable(
  invoice: Pick<Invoice, 'credited_invoice_id' | 'currency' | 'document_type' | 'total' | 'vat_amount' | 'vat_treatment'>
    & Partial<Pick<Invoice, 'payment_details' | 'total_sek' | 'exchange_rate'>>
    & Pick<InvoicePartiesInvoice, 'items'>
    & { customer?: InvoicePartiesCustomer | null },
  settings: CompanySettings,
): IssueRefusal | null {
  if (isCreditNoteDocument(invoice)) return { code: 'INVOICE_CREDIT_NOTE_NOT_ISSUABLE' }
  if (!hasRequiredInvoicePaymentAccount(settings, invoice)) {
    return { code: 'INVOICE_SEND_PAYMENT_ACCOUNT_MISSING', details: { currency: invoice.currency } }
  }
  if (!hasRequiredSellerVatNumber(settings, invoice)) return { code: 'INVOICE_SEND_VAT_NUMBER_MISSING' }
  const parties = invoicePartiesVerdict(invoice, invoice.customer, settings)
  if (parties === 'seller_missing') return { code: 'INVOICE_SEND_SELLER_ADDRESS_MISSING' }
  if (parties === 'buyer_missing') return { code: 'INVOICE_SEND_BUYER_ADDRESS_MISSING' }
  return null
}

/**
 * Whether a document can go out by email. A följesedel travels with the goods:
 * it is marked sent, never emailed (emailBlockReason, the editor's reading).
 */
export function emailRefusal(invoice: Pick<Invoice, 'document_type'>): IssueRefusal | null {
  return invoice.document_type === 'delivery_note' ? { code: 'INVOICE_SEND_DELIVERY_NOTE' } : null
}

/**
 * A draft with no moms_ruta that is not a momsfri sale: an imported draft, as
 * every write path stamps one. A momsfri sale is the one sale with no ruta to
 * state, a seller outside the VAT register and no VAT on the row:
 * deriveInvoiceVatHeader writes null for it, and recreating it writes null
 * again. The treatment alone does not say that: `exempt` also comes from an
 * imported 0 % line, which the mapper cannot tell from reverse charge or
 * export, and from a seller leaving the register with a VAT-bearing draft
 * open. PATCH with items re-derives the header, so those have a way out.
 *
 * v1 mark-sent and v1 send refuse it. No other door reads the column (nor do
 * the books or the declaration, which follow the accounts), so it is not part
 * of issuable.
 */
export function lacksMomsRuta(
  invoice: Pick<Invoice, 'moms_ruta' | 'vat_amount' | 'vat_treatment'>,
  settings: Pick<CompanySettings, 'vat_registered'>,
): boolean {
  if (invoice.moms_ruta) return false
  const momsfriSale = settings.vat_registered === false
    && invoice.vat_treatment === 'exempt'
    && Number(invoice.vat_amount) === 0
  return !momsfriSale
}

export type IssueAndBookResult =
  | {
      ok: true
      journalEntryId: string | null
      partialFailures: IssuePartialFailure[]
    }
  | {
      ok: false
      errorCode: string
      details?: Record<string, unknown>
      /** A sentence written for the user (the series refusal names its numbers). */
      messageSv?: string
      messageEn?: string
      /**
       * INVOICE_MARK_SENT_BOOK_FAILED only: why no verifikat was posted, in
       * Swedish, and the engine's thrown refusal (see MarkSentAndBookResult),
       * so a door can answer with the engine's own code.
       */
      reason?: string
      bookingError?: unknown
    }

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
  /**
   * The kontantfaktura (crm#1281, lib/invoices/paid-at-issue.ts): the invoice
   * is paid when it is issued, to this 19xx account on the fakturadatum.
   * The issue books no registration verifikat; the payment books the one
   * cash verifikat, in either accounting method. issueAndBookInvoice refuses
   * it (INVOICE_PAID_AT_ISSUE_NOT_ALLOWED, paidAtIssueBlockReason) before
   * anything changes; the account is a 19xx one (MarkInvoiceSentPaidAtIssueSchema,
   * checked where the request is parsed). The dashboard and v1 mark-sent and
   * the MCP mark_invoice_sent approval all pass it here.
   */
  paidAtIssue?: { settlementAccountNumber: string } | null
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
    // A kontantfaktura (crm#1281) was settled at issue: its underlag is the
    // paid receipt, BETALD with the date.
    const renderableInvoice = {
      ...(invoice as Invoice),
      status: invoice.status === 'paid' ? ('paid' as const) : ('sent' as const),
    }
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
      isCreditNote: isCreditNoteDocument(invoice),
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
        // The invoice's own PDF on the invoice's own verifikat.
        linkBasis: linkBasisColumns('system_derived'),
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
        /** paidAtIssue only: the payment at issue was refused (settleInvoicePayment's code). */
        | PaidAtIssueSettleFailureCode
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

/** The settleInvoicePayment refusals a kontantfaktura's payment at issue can answer with. */
export type PaidAtIssueSettleFailureCode =
  | 'MATCH_AMOUNT_EXCEEDS_REMAINING'
  | 'INVOICE_PAID_CASH_PARTIAL_UNSUPPORTED'
  | 'INVOICE_PAID_NO_FISCAL_PERIOD'
  | 'INVOICE_PAID_BOOK_FAILED'
  | 'INVOICE_PAID_NOT_PAYABLE'
  | 'INVOICE_QUOTE_NOT_PAYABLE'
  | 'INVOICE_PAID_RACE'
  | 'PAYMENT_DATE_IN_FUTURE'

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

  // A kontantfaktura is paid at issue: its one verifikat is the payment's
  // cash entry below, never a registration entry on 1510.
  const paidAtIssue = opts.paidAtIssue ?? null
  if (paidAtIssue) {
    return settleAtIssue(opts, paidAtIssue.settlementAccountNumber, entityType)
  }

  // Only a faktura books at issue (not proformas, quotes or delivery notes):
  // the same predicate the send dialog describes the outcome with.
  const booksOnIssue = issueBooksDocument(invoice, settings)
  let journalEntryId: string | null = null
  const partialFailures: IssuePartialFailure[] = []
  let bookingReason = 'Fakturans verifikat kunde inte skapas.'
  let bookingError: unknown

  // Custom lines only apply where issuance books inline; elsewhere they are
  // deliberately ignored (documented in MarkInvoiceSentSchema). Log it so the
  // mismatch is visible in audit review instead of vanishing silently.
  if (customLines && !booksOnIssue) {
    log.warn('issue: custom lines ignored (not on accrual book-at-issue path)', {
      invoiceId: id,
      lineCount: customLines.length,
    })
  }

  if (booksOnIssue) {
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
      // The posting port's event, while POSTING_EVENTS is on: the person
      // issued the invoice (a staged approval, an API key or the recurring
      // run resolve to their own basis in linkBasisColumns).
      const posting = () => ({ linkBasis: linkBasisColumns('user_created') })
      const journalEntry = customLines
        ? await createInvoiceJournalEntry(
            supabase,
            companyId,
            userId,
            invoice as Invoice,
            entityType,
            invoice.customer?.name,
            { customLines, posting },
          )
        : await createInvoiceJournalEntry(
            supabase,
            companyId,
            userId,
            invoice as Invoice,
            entityType,
            invoice.customer?.name,
            { posting },
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
          // An upplupen intäkt (17xx) posts all its months now: one that
          // could not leaves 17xx credited without its revenue until retried.
          if ((accrual.releasesFailed ?? 0) > 0) {
            partialFailures.push({
              step: 'accrual_releases',
              reason: ACCRUAL_RELEASE_FAILED_WARNING.message_sv,
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
          // journal_entry_id column is missing (it was absent in production until the
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
  if (booksOnIssue && !journalEntryId) {
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
 * The kontantfaktura's half of the issue step (crm#1281): the invoice was
 * just flipped to 'sent' by the compare-and-set above, so settle it in full
 * on its fakturadatum to the chosen account, booking the sale and the
 * payment as one cash verifikat (settleInvoicePayment with
 * recognizeSaleAtPayment: the kontantmetoden shape in either method).
 *
 * Fail closed like the registration path: when the payment is refused (a
 * locked or missing period, an account outside the chart) the settlement has
 * already cancelled anything it posted, nothing is booked, and the invoice
 * goes back to draft so nobody delivers a receipt the ledger does not have.
 * On success the in-memory row reads paid, so the archived PDF is the
 * receipt the customer gets (BETALD with the date).
 */
async function settleAtIssue(
  opts: IssueAndBookOptions,
  settlementAccountNumber: string,
  entityType: EntityType,
): Promise<MarkSentAndBookResult> {
  const { supabase, companyId, userId, invoice, settings, log } = opts
  const remaining = invoice.remaining_amount ?? roundOre(invoice.total - (invoice.paid_amount ?? 0))

  let settled: Awaited<ReturnType<typeof settleInvoicePayment>>
  try {
    settled = await settleInvoicePayment(supabase, companyId, userId, {
      invoice: { ...(invoice as Invoice), status: 'sent' },
      paymentAmountInInvoiceCurrency: remaining,
      paymentDate: invoice.invoice_date,
      accountingMethod: settings.accounting_method || 'accrual',
      entityType,
      settlementAccountNumber,
      paymentSource: 'manual',
      recognizeSaleAtPayment: true,
    })
  } catch (err) {
    log.error('kontantfaktura: settlement at issue threw', err as Error)
    await restoreUnbookedDraft(supabase, companyId, invoice.id, log)
    return { ok: false, errorCode: 'INVOICE_MARK_SENT_BOOK_FAILED', reason: getErrorMessage(err), bookingError: err }
  }

  if (!settled.ok) {
    await restoreUnbookedDraft(supabase, companyId, invoice.id, log)
    switch (settled.code) {
      case 'BOOKKEEPING_ERROR':
        return {
          ok: false,
          errorCode: 'INVOICE_MARK_SENT_BOOK_FAILED',
          reason: getErrorMessage(settled.error),
          bookingError: settled.error,
        }
      case 'UPDATE_FAILED':
      case 'INVOICE_PAID_LINES_UNBALANCED':
        log.error('kontantfaktura: settlement at issue failed', settled.code === 'UPDATE_FAILED' ? settled.error as Error : undefined)
        return { ok: false, errorCode: 'INVOICE_MARK_SENT_BOOK_FAILED' }
      case 'SALE_FIRST_REFUSED':
        // Not reached: the cash entry books the kontantfaktura's sale itself,
        // so settleInvoicePayment plans no sale first for it. Fail closed if
        // it ever does: nothing was written.
        log.error('kontantfaktura: settlement at issue planned a sale first', undefined, {
          refusalCode: settled.refusal.code,
        })
        return { ok: false, errorCode: 'INVOICE_MARK_SENT_BOOK_FAILED' }
      default:
        return { ok: false, errorCode: settled.code }
    }
  }

  // The issue's tail (archive, delivery, invoice.sent) renders from this row.
  Object.assign(invoice, {
    status: settled.newStatus,
    paid_amount: settled.newPaidAmount,
    remaining_amount: settled.newRemaining,
    paid_at: settled.paidAt,
  })
  return { ok: true, journalEntryId: settled.journalEntryId, partialFailures: [] }
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

  // A kontantfaktura (crm#1281) only for a plain faktura without custom
  // lines: refused here, for every door, before the payee is frozen or a
  // number taken, so nothing has changed when it refuses.
  if (opts.paidAtIssue) {
    const reason = paidAtIssueBlockReason(invoice, { customLines: opts.customLines })
    if (reason) {
      return { ok: false, errorCode: 'INVOICE_PAID_AT_ISSUE_NOT_ALLOWED', details: { reason } }
    }
  }

  // An invoice that chose a bank account freezes that account's payee now,
  // from the account as it is at issue; a chosen account that can no longer
  // be used blocks issue instead of silently printing the company default.
  const payeeSnapshot = await snapshotInvoicePayee(supabase, companyId, invoice as Invoice)
  if (!payeeSnapshot.ok) {
    return { ok: false, errorCode: payeeSnapshot.code, details: payeeSnapshot.details }
  }
  ;(invoice as Invoice).payment_details = payeeSnapshot.payee

  const refused = issuable(invoice, settings)
  if (refused) return { ok: false, errorCode: refused.code, details: refused.details }

  // Assign the number only after all payment-instruction guards pass.
  try {
    await ensureInvoiceNumber(supabase, companyId, invoice as Invoice)
  } catch (err) {
    log.error('failed to assign invoice number on mark-sent', err as Error)
    const failure = invoiceNumberingFailure(err, 'INVOICE_CREATE_NUMBER_ASSIGN_FAILED')
    return {
      ok: false,
      errorCode: failure.code,
      ...(failure.details ? { details: failure.details } : {}),
      ...(failure.messageSv ? { messageSv: failure.messageSv, messageEn: failure.messageEn } : {}),
    }
  }

  const issued = await markInvoiceSentAndBook(opts)
  if (!issued.ok) {
    return {
      ok: false,
      errorCode: issued.errorCode,
      ...(issued.reason !== undefined ? { reason: issued.reason } : {}),
      ...(issued.bookingError !== undefined ? { bookingError: issued.bookingError } : {}),
    }
  }
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

  await emitInvoiceSent({ supabase, companyId, userId, invoice: invoice as Invoice, settings, log })

  return failures
}
