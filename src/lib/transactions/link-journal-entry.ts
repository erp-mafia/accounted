/**
 * Link a bank transaction to an already-posted journal entry without creating
 * new bookkeeping. Optionally settle a customer invoice in the same call by
 * inserting an invoice_payments row pointing at the existing JE and flipping
 * the invoice status with an optimistic-lock pattern.
 *
 * One implementation behind the dashboard route
 * (app/api/transactions/[id]/link-journal-entry/route.ts: the duplicate-
 * payment UI, where the user confirms the suggested existing voucher) and
 * the operation transactions.link-journal-entry (lib/operations/
 * transactions.ts), which serves v1, the MCP tool
 * gnubok_link_transaction_to_journal_entry and its approval. The bank side
 * of the link (which pairs may link, and the locked pointer write) is the
 * bank link core in lib/transactions/bank-link.ts, shared with the
 * reconciliation page's manualLink.
 *
 * Creates no payment entry: the existing verifikat is the payment. The one
 * exception is the sale of an invoice the company books in a separate step
 * (faktureringsmetoden with defer_invoice_booking) and has not booked yet:
 * when the linked verifikat clears the receivable (credits 151x), the Bokför
 * step books the sale first, on its invoice date (lib/invoices/sale-first.ts),
 * so 1510 never carries a credit no sale debited. A verifikat that books the
 * revenue itself (no 151x credit) never gets that far: the settlement side
 * (invoice_settlement_side, #3440) refuses it for every invoice outside
 * kontantmetoden, before the sale is planned. The match log records
 * 'linked_to_existing_voucher' for audit on success.
 */
import { isCreditNoteDocument } from '@/lib/bookkeeping/credit-note-state'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import type { SupabaseClient } from '@supabase/supabase-js'
import { releaseDoubtfulReserveAfterChange } from '@/lib/customer-loss/doubtful'
import { eventBus } from '@/lib/events/bus'
import { planInvoicePayment } from '@/lib/invoices/apply-invoice-payment'
import { clearSettledInvoiceSuggestions } from '@/lib/invoices/clear-settled-invoice-suggestions'
import { paidAtFromDate } from '@/lib/invoices/paid-at'
import { emitInvoicePaidIfSettled } from '@/lib/invoices/paid-events'
import { equalOre, roundOre, sumOre } from '@/lib/money'
import { carriedSekOf } from '@/lib/bookkeeping/ledger-carried-sek'
import { isKronorCurrency } from '@/lib/bookkeeping/currency-utils'
import { storedRemaining } from '@/lib/invoices/voucher-matching-shared'
import { recordInvoicePaymentRow } from '@/lib/invoices/invoice-payment-row'
import { hasActiveCreditNote } from '@/lib/transactions/invoice-document-refusal'
import { resolveInvoiceSettlementSide } from '@/lib/invoices/invoice-settlement-side'
import { logMatchEvent } from '@/lib/invoices/match-log'
import { propagateUnderlagForBookedTransaction } from '@/lib/transactions/inbox-underlag'
import {
  bankLinkMethod,
  hasLiveJournalEntryLink,
  prepareBankLink,
  writeBankLink,
  type PreparedBankLink,
} from '@/lib/transactions/bank-link'
import { createLogger } from '@/lib/logger'
import { learnFromBankLink } from '@/lib/transactions/link-learning'
import { conflictCode } from '@/lib/errors/structured-errors'
import type { Invoice, Transaction } from '@/types'
import { getActor } from '@/lib/bookkeeping/actor-context'
import { isPersonReview, matchBookingOfRows } from '@/lib/booking-review/check'
import { loadActiveBookingReviewRules } from '@/lib/booking-review/rules'
import { isMatchableInvoiceStatus, MATCHABLE_INVOICE_STATUSES } from '@/lib/bookkeeping/matchable-statuses'
import type { EntryPreview } from '@/lib/bookkeeping/entry-preview'
import {
  bookSaleBeforeSettlement,
  clearsReceivable,
  planSaleBeforeSettlementById,
  SALE_FIRST_NOT_REQUIRED,
  saleFirstRefusalCode,
  type SaleFirstPlan,
  type SaleFirstRefusal,
} from '@/lib/invoices/sale-first'

const log = createLogger('transactions/link-journal-entry')

// Codes returned by linkTransactionToJournalEntry. All map to entries in
// lib/errors/structured-errors.ts so every door (the dashboard route, the
// operation) can surface the right HTTP status and the localized message.
// The TX-not-found case reuses the shared TX_CATEGORIZE_TX_NOT_FOUND code
// rather than a link-specific one: it predates this route and is the
// canonical "bank tx not found in this company" envelope.
export type LinkTransactionJournalEntryErrorCode =
  | ReturnType<typeof conflictCode>
  | 'BOOKING_REVIEW_REQUIRED'
  | 'TX_CATEGORIZE_TX_NOT_FOUND'
  | 'LINK_TX_TX_ALREADY_LINKED'
  | 'LINK_TX_TX_IGNORED'
  | 'BANK_ANCHOR_SETTLEMENT_CHANGED'
  | 'VOUCHER_BANK_LEG_CONSUMED'
  | 'LINK_TX_JE_NOT_FOUND'
  | 'LINK_TX_JE_NOT_POSTED'
  | 'LINK_TX_INVOICE_NOT_FOUND'
  | 'LINK_TX_INVOICE_NOT_OPEN'
  | 'LINK_TX_INVOICE_CREDIT_NOTE'
  | 'LINK_TX_INVOICE_CURRENCY_MISMATCH'
  | 'LINK_TX_INVOICE_SETTLEMENT_SIDE'
  | 'LINK_TX_INVOICE_RACE'
  | 'MATCH_AMOUNT_EXCEEDS_REMAINING'
  | 'MATCH_INVOICE_RECORD_PAYMENT_FAILED'
  | 'BANK_BOOKING_CURRENCY_MISMATCH'
  | 'LINK_TX_DB_ERROR'

export interface LinkTransactionJournalEntryParams {
  transactionId: string
  journalEntryId: string
  invoiceId?: string
}

export interface LinkTransactionJournalEntryResult {
  transactionId: string
  journalEntryId: string
  voucherLabel: string
  invoiceId: string | null
  invoiceStatus: 'paid' | 'partially_paid' | null
  paidAmount: number | null
  remainingAmount: number | null
  /** The sale verifikat this link booked first (defer_invoice_booking), else null. */
  saleJournalEntryId: string | null
}

/**
 * What a dry run read on the way, so an approver can recognise the pair:
 * the row (its counterparty text, amount, currency, date), the verifikat's
 * date and the invoice number.
 */
export interface LinkTransactionJournalEntrySubject {
  transactionDescription: string | null
  transactionAmount: number
  transactionCurrency: string
  transactionDate: string
  voucherDate: string
  invoiceNumber: string | null
  /** The sale verifikat the link books first (defer_invoice_booking), as the Bokför dry run builds it. */
  saleEntry: EntryPreview | null
}

export type LinkTransactionJournalEntryOutcome =
  // dryRun: the result the link WOULD produce; nothing was written.
  | { ok: true; result: LinkTransactionJournalEntryResult; dryRun?: false }
  | { ok: true; result: LinkTransactionJournalEntryResult; dryRun: true; subject: LinkTransactionJournalEntrySubject }
  // A link refusal, or the Bokför step's code when the sale the link books
  // first was refused (details.sale_first).
  | { ok: false; code: LinkTransactionJournalEntryErrorCode | SaleFirstRefusal['code']; details?: Record<string, unknown> }

// The liveness predicate lives with the bank link core; re-exported for the
// re-booking guards that import it from here.
export { hasLiveJournalEntryLink }

/**
 * A refusal of the bank link core as this door's structured error code. The
 * core's checks are the reconciliation page's: a row the page refuses to
 * link (ignored, or a verifikat with no line on the row's bank account) is
 * refused here by name too, on the dry run and the approval alike, instead
 * of the database's bank-anchor guard answering at the write.
 */
function linkRefusal(
  prepared: Extract<PreparedBankLink, { ok: false }>,
): Extract<LinkTransactionJournalEntryOutcome, { ok: false }> {
  switch (prepared.code) {
    case 'TRANSACTION_NOT_FOUND':
      return { ok: false, code: 'TX_CATEGORIZE_TX_NOT_FOUND' }
    case 'TRANSACTION_ALREADY_LINKED':
      return {
        ok: false,
        code: 'LINK_TX_TX_ALREADY_LINKED',
        details: { existingJournalEntryId: prepared.existingJournalEntryId ?? null },
      }
    case 'TRANSACTION_IGNORED':
      return { ok: false, code: 'LINK_TX_TX_IGNORED' }
    case 'ENTRY_NOT_FOUND':
      return { ok: false, code: 'LINK_TX_JE_NOT_FOUND' }
    case 'ENTRY_NOT_POSTED':
    case 'ENTRY_REVERSED':
      return { ok: false, code: 'LINK_TX_JE_NOT_POSTED', details: { currentStatus: prepared.entryStatus ?? null } }
    case 'ENTRY_NOT_BANK_MOVEMENT':
      return { ok: false, code: 'LINK_TX_JE_NOT_BANK_MOVEMENT' }
    case 'CURRENCY_MISMATCH':
      return { ok: false, code: 'BANK_BOOKING_CURRENCY_MISMATCH', details: { reason: prepared.error } }
    // Other rows already hold the verifikat's bank leg (GitHub #3507): its
    // own code, so an agent books the row instead of retrying the link.
    case 'VOUCHER_BANK_LEG_CONSUMED':
      return {
        ok: false,
        code: 'VOUCHER_BANK_LEG_CONSUMED',
        details: {
          reason: prepared.error,
          booked: prepared.bankLeg?.booked ?? null,
          held: prepared.bankLeg?.held ?? null,
          remaining: prepared.bankLeg?.remaining ?? null,
        },
      }
    default:
      // NOT_SETTLED, BANK_ANCHOR_REFUSED (a verifikat that books nothing in
      // the row's direction, booksDirection) and TRANSACTION_OTHER_ACCOUNT
      // (which cannot happen on the row's own account): the answer the
      // bank-anchor guard gives the same pair at the write.
      return { ok: false, code: 'BANK_ANCHOR_SETTLEMENT_CHANGED', details: { reason: prepared.error } }
  }
}

// Data minimization (GDPR Art.5(1)(c)): only the columns needed for the
// checks, the optimistic-lock invoice update, the invoice_payments insert,
// and the compensating-rollback path. No select('*').
const LINK_TX_COLUMNS =
  'id, date, amount, amount_sek, currency, exchange_rate, description, merchant_name, original_description, cash_account_id, journal_entry_id, reconciliation_method, invoice_id, is_business, is_ignored, potential_invoice_id, potential_supplier_invoice_id, potential_rot_rut_payout_request_id'

export async function linkTransactionToJournalEntry(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: LinkTransactionJournalEntryParams,
  options: { dryRun?: boolean } = {},
): Promise<LinkTransactionJournalEntryOutcome> {
  const { transactionId, journalEntryId, invoiceId } = params

  // Every bank check is the bank link core's (lib/transactions/bank-link.ts),
  // the one manualLink runs for the reconciliation page.
  const prepared = await prepareBankLink(supabase, companyId, {
    transactionId,
    journalEntryId,
    accountNumber: null,
    txColumns: LINK_TX_COLUMNS,
  })
  if (!prepared.ok) return linkRefusal(prepared)
  const transaction = prepared.tx as Record<string, unknown> & {
    date: string
    amount: number
    currency: string
    exchange_rate: number | null
  }
  const journalEntry = prepared.entry

  // Hard blocks (accounted#130 step 2): linking the row books it on the
  // verifikat's lines. A key, an agent or cron may not book a row a booking
  // review rule matches that way either (a verifikat posted first, then
  // linked); a person linking it in the app has the verifikat in front of them.
  const linkActor = getActor()
  if (linkActor && !isPersonReview(linkActor)) {
    const rules = await loadActiveBookingReviewRules(supabase, companyId)
    if (rules.length > 0) {
      const { data: entryLines } = await supabase
        .from('journal_entry_lines')
        .select('account_number, debit_amount, credit_amount')
        .eq('journal_entry_id', journalEntryId)
      const matched = await matchBookingOfRows(
        supabase,
        companyId,
        [transaction as unknown as Parameters<typeof matchBookingOfRows>[2][number]],
        Array.isArray(entryLines) ? (entryLines as Array<{ account_number: string; debit_amount: number; credit_amount: number }>) : [],
        rules,
      )
      if (matched.length > 0) {
        return { ok: false, code: 'BOOKING_REVIEW_REQUIRED', details: { transaction_id: transactionId, matched_rules: matched } }
      }
    }
  }

  type FetchedInvoice = Pick<
    Invoice,
    | 'id'
    | 'status'
    | 'total'
    | 'paid_amount'
    | 'remaining_amount'
    | 'currency'
    | 'exchange_rate'
    | 'paid_at'
    | 'invoice_number'
    | 'credited_invoice_id'
    | 'journal_entry_id'
  > & { customer?: { name?: string } | null }
  let invoice: FetchedInvoice | null = null
  let newPaidAmount = 0
  let newRemaining = 0
  let isFullyPaid = false
  let newStatus: 'paid' | 'partially_paid' = 'paid'

  if (invoiceId) {
    // Data minimization (GDPR Art.5(1)(c) / SOC 2 CC6.1): explicit column
    // list rather than select('*, customer:customers(name)'). Adding new
    // PII columns to invoices won't silently widen this fetch.
    const { data: invoiceRow, error: fetchInvError } = await supabase
      .from('invoices')
      .select(
        'id, status, total, paid_amount, remaining_amount, currency, exchange_rate, paid_at, invoice_number, credited_invoice_id, journal_entry_id, customer:customers(name), credit_notes:invoices!credited_invoice_id(id, status, creation_complete)'
      )
      .eq('id', invoiceId)
      .eq('company_id', companyId)
      .single()

    if (fetchInvError || !invoiceRow) {
      return { ok: false, code: 'LINK_TX_INVOICE_NOT_FOUND' }
    }

    // One rule with the match doors: a credit note, or an original with an
    // active credit note, takes no payment.
    if (isCreditNoteDocument(invoiceRow) || hasActiveCreditNote(invoiceRow)) {
      return { ok: false, code: 'LINK_TX_INVOICE_CREDIT_NOTE' }
    }

    if (!isMatchableInvoiceStatus(invoiceRow.status as string)) {
      return {
        ok: false,
        code: 'LINK_TX_INVOICE_NOT_OPEN',
        details: { currentStatus: invoiceRow.status as string },
      }
    }

    invoice = invoiceRow as unknown as FetchedInvoice

    // BFL 5 kap 2§ + currency-integrity guard: invoices.paid_amount and
    // remaining_amount are stored in the INVOICE'S currency. Mixing a
    // foreign-currency tx.amount into those columns silently corrupts the
    // ledger (a 230 SEK payment would record "230 USD paid" on a USD
    // invoice). This link path is for the same-currency case only;
    // cross-currency payments must go through /api/transactions/[id]/match-
    // invoice which routes through buildInvoicePaymentClearingLines and
    // posts the FX diff on 3960/7960. Reject here to keep the contract clear.
    if (transaction.currency !== invoice.currency) {
      return {
        ok: false,
        code: 'LINK_TX_INVOICE_CURRENCY_MISMATCH',
        details: {
          transactionCurrency: transaction.currency as string,
          invoiceCurrency: invoice.currency,
        },
      }
    }

    // The verifikat must settle the invoice on the invoice's own side, the
    // rule link_invoice_to_voucher reads (invoice_settlement_side,
    // 20261018131110): the 19xx debit for a kontantmetod invoice never
    // booked, the 151x credit for every other one, including a kontantmetod
    // invoice carried over the year end (#3440). Linking a carried invoice
    // to a voucher that books revenue and moms would declare its moms a
    // second time and leave 1510 open, and no database guard sees it.
    const side = await resolveInvoiceSettlementSide(supabase, companyId, invoiceId)
    const { data: voucherLines, error: voucherLinesError } = await supabase
      .from('journal_entry_lines')
      .select('account_number, debit_amount, credit_amount')
      .eq('journal_entry_id', journalEntryId)
      .like('account_number', `${side.accountPrefix}%`)
    if (voucherLinesError) {
      return { ok: false, code: 'LINK_TX_DB_ERROR', details: { reason: voucherLinesError.message } }
    }
    const sideLines = (voucherLines ?? []) as Array<{
      account_number: string | null
      debit_amount: number | string | null
      credit_amount: number | string | null
    }>
    const settlesOnSide = sideLines.some(
      (line) =>
        String(line.account_number ?? '').startsWith(side.accountPrefix) &&
        Number((side.entrySide === 'debit' ? line.debit_amount : line.credit_amount) ?? 0) > 0,
    )
    if (!settlesOnSide) {
      return {
        ok: false,
        code: 'LINK_TX_INVOICE_SETTLEMENT_SIDE',
        details: {
          settlementSide: side.side,
          accountPrefix: side.accountPrefix,
          entrySide: side.entrySide,
        },
      }
    }

    // A SEK invoice whose own verifikat booked the öresavrundning (1510 at the
    // rounded "Att betala", the öre on 3740) is settled in full when the row
    // and the verifikat both clear exactly what 151x carries for it: the rule
    // of the voucher link (validateVoucherForInvoiceLink) and the other
    // settlement doors (bookedOreRounding over carriedSekOf). Otherwise the
    // one payment plan, strict: no öre absorption, and a bank row larger than
    // the invoice's remainder is refused before anything is written.
    const settlesCarried =
      side.side === 'ar_credit' &&
      (await clearsBookedOre(supabase, companyId, invoice, journalEntryId, transaction.amount, sideLines))
    const payment = planInvoicePayment(invoice, settlesCarried ? storedRemaining(invoice) : transaction.amount)
    if (!payment.ok) return { ok: false, code: payment.code, details: payment.details }
    ;({ newPaidAmount, newRemaining, isFullyPaid, newStatus } = payment.plan)
  }

  // Faktureringsmetoden with defer_invoice_booking: an invoice sent without
  // its verifikat gets its sale booked first, by the Bokför step on its
  // invoice date, when the verifikat clears the receivable. Planned here, so
  // a refusal comes before anything is written.
  const saleCtx = { supabase, companyId, userId, log }
  let salePlan: SaleFirstPlan = SALE_FIRST_NOT_REQUIRED
  if (invoice && invoiceId) {
    const plan = await planSaleBeforeSettlementById(saleCtx, invoiceId)
    if (!plan.ok) return { ok: false, code: saleFirstRefusalCode(plan), details: plan.details }
    if (plan.required) {
      const clears = await verifikatClearsReceivable(supabase, journalEntryId)
      if (clears === null) return { ok: false, code: 'LINK_TX_DB_ERROR', details: { reason: 'journal entry lines unreadable' } }
      if (clears) salePlan = plan
    }
  }

  // Dry run (the v1 ?dry_run=true door): every check above ran on the same
  // reads the commit uses; answer the projected result and write nothing.
  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      result: {
        transactionId,
        journalEntryId,
        // "A-12": the form the v1 voucher_label is documented in. The dry run
        // and the commit format it the same way, so the label the approver saw
        // is the label the audit trail keeps (BFL 5 kap 7 §).
        voucherLabel: formatVoucher(journalEntry, { separator: '-' }),
        invoiceId: invoiceId ?? null,
        invoiceStatus: invoice ? newStatus : null,
        paidAmount: invoice ? newPaidAmount : null,
        remainingAmount: invoice ? newRemaining : null,
        saleJournalEntryId: null,
      },
      subject: {
        transactionDescription:
          ((transaction.merchant_name as string | null) || (transaction.description as string | null)) ?? null,
        transactionAmount: transaction.amount as number,
        transactionCurrency: (transaction.currency as string | null) ?? 'SEK',
        transactionDate: transaction.date as string,
        voucherDate: journalEntry.entry_date as string,
        invoiceNumber: (invoice?.invoice_number as string | null | undefined) ?? null,
        saleEntry: salePlan.required ? salePlan.entry : null,
      },
    }
  }

  // Snapshot tx state so the compensating-rollback path can restore the row
  // if a subsequent step fails: otherwise a partial state would persist
  // (tx linked, invoice unchanged, no payment row).
  const priorTxState = {
    // null, or a stale 'reversed'-entry id we're clearing (validated not-live above)
    journal_entry_id: prepared.previousJournalEntryId,
    // The link writes its reconciliation_method (writeBankLink).
    reconciliation_method: (transaction.reconciliation_method as string | null | undefined) ?? null,
    // A link to a voucher on a sibling ledger moved the row there.
    ...(prepared.repointCashAccountId ? { cash_account_id: transaction.cash_account_id } : {}),
    invoice_id: transaction.invoice_id,
    potential_invoice_id: transaction.potential_invoice_id,
    potential_supplier_invoice_id: transaction.potential_supplier_invoice_id,
    potential_rot_rut_payout_request_id: transaction.potential_rot_rut_payout_request_id ?? null,
    is_business: transaction.is_business,
  }

  // The sale first: a correct booking of the sent invoice whatever happens
  // to the link after it.
  const sale = await bookSaleBeforeSettlement(saleCtx, salePlan)
  if (!sale.ok) return { ok: false, code: saleFirstRefusalCode(sale), details: sale.details }
  const saleJournalEntryId = sale.bookedHere ? sale.journalEntryId : null

  const written = await writeBankLink(supabase, companyId, {
    transactionId,
    journalEntryId,
    prepared,
    fields: {
      invoice_id: invoiceId ?? null,
      potential_invoice_id: null,
      potential_supplier_invoice_id: null,
      potential_rot_rut_payout_request_id: null,
    },
    // The caller named this verifikat for this row (the duplicate dialog, v1,
    // the MCP tool); the request scope says whether a person approved it.
    linkBasis: { basis: 'user_confirmed' },
  })
  if (!written.ok && !written.race) {
    const { error } = written
    return {
      ok: false,
      code: error.code === 'PT409' ? conflictCode(error.message) : 'LINK_TX_DB_ERROR',
      details: { reason: error.message },
    }
  }
  // CAS lost: a concurrent linker changed the pointer between the liveness
  // check and this write, so 0 rows matched. Fail BEFORE any invoice side
  // effects: otherwise we'd settle the invoice + insert an invoice_payments row
  // for a transaction we didn't actually link.
  if (!written.ok) {
    return {
      ok: false,
      code: 'LINK_TX_TX_ALREADY_LINKED',
      details: { existingJournalEntryId: prepared.previousJournalEntryId },
    }
  }

  async function rollbackTxLink(reason: string): Promise<void> {
    // SOC 2 PI1.3 (processing integrity): if a rollback itself fails, the
    // ledger ends up in a partial state: tx pointing at the existing
    // verifikat with no invoice_payments row, or the invoice row at an
    // intermediate paid_amount. We surface the rollback failure (IDs only,
    // no amounts or counterparty names) so a reconciliation job can
    // detect and repair the divergence. The original failure code still
    // goes back to the caller as the proximate cause.
    const { error: rollbackErr } = await supabase
      .from('transactions')
      .update(priorTxState)
      .eq('id', transactionId)
      .eq('company_id', companyId)
    if (rollbackErr) {
      log.warn('failed to roll back transaction link after subsequent step failed', {
        companyId,
        transactionId,
        journalEntryId,
        reason,
        rollbackError: rollbackErr.message,
      })
    }
  }

  const paidAt = invoice && isFullyPaid ? paidAtFromDate(transaction.date) : null

  if (invoice && invoiceId) {
    const { data: updatedRows, error: updateInvError } = await supabase
      .from('invoices')
      .update({
        status: newStatus,
        paid_at: paidAt,
        paid_amount: newPaidAmount,
        remaining_amount: newRemaining,
      })
      .eq('id', invoiceId)
      .eq('company_id', companyId)
      .in('status', [...MATCHABLE_INVOICE_STATUSES])
      .select('id')

    if (updateInvError) {
      await rollbackTxLink('invoice update errored')
      return { ok: false, code: 'LINK_TX_DB_ERROR', details: { reason: updateInvError.message } }
    }

    if (!updatedRows || updatedRows.length === 0) {
      await rollbackTxLink('invoice optimistic lock returned 0 rows')
      return { ok: false, code: 'LINK_TX_INVOICE_RACE' }
    }

    // BFL 5 kap 2§ + ML 8 kap 21-23§: the payment row must record the rate
    // effective on the PAYMENT date, not the invoice-creation date. If
    // transaction.exchange_rate is null (SEK tx, no rate needed), leave the
    // payment row's rate null too: a downstream Riksbanken lookup can
    // populate it lazily if reporting needs it. Falling back to
    // invoice.exchange_rate would silently record the wrong (invoice-date)
    // rate, which corrupts the FX-diff figures in any later VAT or income
    // reporting.
    const paymentExchangeRate = transaction.exchange_rate ?? null

    // The AR sub-ledger row goes through the single writer
    // (lib/invoices/invoice-payment-row.ts). This path plans strictly (no öre
    // absorption, same currency only), so the applied amount IS the bank line
    // to the öre, except on an invoice whose own verifikat booked the öre: the
    // row that clears what 1510 carries applies the whole remainder. The
    // writer is used for one set of row semantics. A unique violation (23505)
    // means the row already exists for this voucher and is not an error here.
    const recorded = await recordInvoicePaymentRow(supabase, {
      userId,
      companyId,
      invoice,
      paymentDate: transaction.date,
      newPaidAmount,
      journalEntryId,
      transactionId,
      exchangeRate: paymentExchangeRate,
      notes: 'Kopplad till befintlig verifikation (ingen ny bokföring skapad)',
      source: 'link',
      // The caller named the verifikat and the invoice it settles.
      linkBasis: { basis: 'user_confirmed' },
    })

    if (!recorded.ok && recorded.code !== '23505') {
      const { error: invRevertErr } = await supabase
        .from('invoices')
        .update({
          status: invoice.status,
          paid_at: invoice.paid_at ?? null,
          paid_amount: invoice.paid_amount ?? 0,
          remaining_amount: invoice.remaining_amount ?? invoice.total,
        })
        .eq('id', invoiceId)
        .eq('company_id', companyId)
      if (invRevertErr) {
        log.warn('failed to revert invoice status after payment insert failed', {
          companyId,
          invoiceId,
          rollbackError: invRevertErr.message,
        })
      }
      await rollbackTxLink('invoice_payments insert failed')
      return { ok: false, code: 'MATCH_INVOICE_RECORD_PAYMENT_FAILED' }
    }

    // The invoice is settled, so every transaction still carrying a suggestion
    // pointer at it is dead: retire them (issue #1259). No exceptTransactionId
    // needed: this row's own hints were already nulled by the tx update above,
    // so the invoice-id filter no longer selects it.
    if (isFullyPaid) {
      await clearSettledInvoiceSuggestions(supabase, companyId, 'invoice', invoiceId)
    }
  }

  // The transaction is now anchored to an existing verifikat: complete any
  // matched inbox items against it (underlag link + consumed stamp) so they
  // leave the active inbox. Best-effort, logged inside.
  await propagateUnderlagForBookedTransaction(supabase, companyId, transactionId, journalEntryId)

  await logMatchEvent(supabase, userId, transactionId, 'linked_to_existing_voucher', {
    invoiceId,
    newState: {
      journal_entry_id: journalEntryId,
      reconciliation_method: bankLinkMethod(prepared.entry, transactionId),
      invoice_id: invoiceId ?? null,
      invoice_status: invoice ? newStatus : null,
    },
  })

  if (invoice && invoiceId) {
    const settledInvoice = {
      ...invoice,
      status: newStatus,
      paid_at: paidAt,
      paid_amount: newPaidAmount,
      remaining_amount: newRemaining,
    } as Invoice
    try {
      await eventBus.emit({
        type: 'invoice.match_confirmed',
        payload: {
          invoice: settledInvoice,
          transaction: {
            ...transaction,
            journal_entry_id: journalEntryId,
            invoice_id: invoiceId,
            potential_rot_rut_payout_request_id: null,
            potential_invoice_id: null,
            potential_supplier_invoice_id: null,
            is_business: true,
          } as Transaction,
          userId,
          companyId,
        },
      })
    } catch {
      /* non-critical */
    }
    // Linking the payment that settles the invoice in full is its
    // invoice.paid transition; a partial link is not. The CAS update above
    // admits one winner, so this fires once. Subscribers get the full
    // committed row like every other settlement door (the narrow read above
    // lacks e.g. stripe_payment_link_id, which the Stripe handler needs), so
    // it is re-read on this transition only. Same-currency only (guarded
    // above), so the applied amount is in the invoice currency.
    if (newStatus === 'paid') {
      const { data: committedInvoice } = await supabase
        .from('invoices')
        .select('*')
        .eq('id', invoiceId)
        .eq('company_id', companyId)
        .maybeSingle()
      await emitInvoicePaidIfSettled({
        newStatus,
        invoice: (committedInvoice as Invoice | null) ?? settledInvoice,
        paymentAmount: roundOre(newPaidAmount - (invoice.paid_amount ?? 0)),
        paymentDate: transaction.date as string,
        userId,
        companyId,
      })
    }
    // A befarad kundförlust reserve the payment made unnecessary comes back
    // (Dr 1519 / Cr 6352), as on every payment path. Never throws.
    await releaseDoubtfulReserveAfterChange(supabase, companyId, userId, {
      invoiceId,
      entryDate: transaction.date as string,
      trigger: 'payment',
    })
  }

  // The caller named this verifikat for this row, so the row teaches its
  // bank text from it at once (crm#1746). A link that settles an invoice
  // teaches nothing: the invoice match is that row's next proposal. Never
  // fails the link: learnFromBankLink logs and returns.
  if (!invoiceId) {
    await learnFromBankLink(supabase, companyId, { transactionId, journalEntryId }, 'explicit')
  }

  const voucherLabel = formatVoucher(journalEntry, { separator: '-' })

  return {
    ok: true,
    result: {
      transactionId,
      journalEntryId,
      voucherLabel,
      invoiceId: invoiceId ?? null,
      invoiceStatus: invoice ? newStatus : null,
      paidAmount: invoice ? newPaidAmount : null,
      remainingAmount: invoice ? newRemaining : null,
      saleJournalEntryId,
    },
  }
}

/**
 * Whether the verifikat's lines clear the receivable (credit 151x): the
 * payment the sale must be booked before. null when the lines cannot be read.
 */
async function verifikatClearsReceivable(supabase: SupabaseClient, journalEntryId: string): Promise<boolean | null> {
  const { data, error } = await supabase
    .from('journal_entry_lines')
    .select('account_number, credit_amount')
    .eq('journal_entry_id', journalEntryId)
  if (error) {
    log.warn('failed to read the linked verifikat lines for the sale-first check', { journalEntryId, error: error.message })
    return null
  }
  return clearsReceivable((data ?? []) as Array<{ account_number: string; credit_amount: number | null }>)
}

/**
 * Whether the bank row and the linked verifikat settle in full a SEK invoice
 * whose own verifikat booked the öresavrundning: carriedSekOf answers what
 * 151x carries for it only then, and both the row and what the verifikat's
 * 151x credit has left after the rows of other invoices it settles must be
 * exactly that. A failed read answers false: the row is then planned against
 * the remainder, as before.
 */
async function clearsBookedOre(
  supabase: SupabaseClient,
  companyId: string,
  invoice: Pick<Invoice, 'id' | 'currency' | 'total' | 'paid_amount' | 'remaining_amount' | 'journal_entry_id'>,
  journalEntryId: string,
  rowAmount: number,
  sideLines: ReadonlyArray<{ credit_amount: number | string | null }>,
): Promise<boolean> {
  if (!isKronorCurrency(invoice.currency)) return false
  let carried: number | null
  try {
    carried = await carriedSekOf(supabase, companyId, 'customer', invoice)
  } catch (error) {
    log.warn('carried SEK read failed; the row is planned against the remainder', {
      companyId,
      invoiceId: invoice.id,
      message: error instanceof Error ? error.message : String(error),
    })
    return false
  }
  if (carried === null || !equalOre(rowAmount, carried)) return false

  const { data: rows, error } = await supabase
    .from('invoice_payments')
    .select('invoice_id, amount, currency')
    .eq('company_id', companyId)
    .eq('journal_entry_id', journalEntryId)
  if (error) {
    log.warn('payment rows of the verifikat unreadable; the row is planned against the remainder', {
      companyId,
      journalEntryId,
      message: error.message,
    })
    return false
  }
  const others = ((rows ?? []) as Array<{ invoice_id: string; amount: number | string | null; currency: string | null }>)
    .filter((row) => row.invoice_id !== invoice.id)
  if (others.some((row) => !isKronorCurrency(row.currency ?? 'SEK'))) return false
  const credited = sumOre(sideLines.map((line) => Number(line.credit_amount ?? 0) || 0))
  const used = sumOre(others.map((row) => Number(row.amount ?? 0) || 0))
  return equalOre(roundOre(credited - used), carried)
}
