/**
 * Book one bank debit as the payment of one supplier invoice: the whole
 * settlement behind the dashboard match door, as one function.
 *
 * The caller has the transaction and the invoice and has refused what it
 * refuses (a non-expense row, a row linked to a supplier invoice, a paid
 * invoice); this function does the rest: the booked-row gate, the payment
 * plan (planSupplierBankMatch), the open-period gate, the payment verifikat
 * through the engine, the bank row claimed behind a compare-and-set, the
 * invoice's ledger update behind a status CAS, the supplier_invoice_payments
 * row (which settles a bank payment order through
 * settle_payment_order_on_supplier_payment), the retired suggestions, the
 * document anchoring, the match log and the events.
 *
 * A bank row that is already booked is refused here, for every caller
 * (accounted#58): the pointer or a bank_line link names a posted verifikat,
 * or the row is a reconciliation link (decideBankRowRebooking). Matching it
 * used to post a second payment verifikat and leave the first one posted
 * with no row, so the bank account was credited twice. The one way past is
 * the row's own categorization with `stornoExisting`, which a person
 * confirms: that verifikat is reversed (storno), then the payment books.
 *
 * Callers: a person confirming a suggestion (the dashboard match route and
 * its v1 twin, action 'matched'), the Inkorg's register-and-settle, and the
 * debit of a bank payment order the owner already BankID-signed
 * (lib/payments/orders/auto-settle.ts, action 'auto_matched').
 *
 * A deferring company's unbooked invoice (defer_invoice_booking) is booked
 * first by the Bokför step, once every check has run, and the payment then
 * clears the 2440 it credits (lib/supplier-invoices/registration-first.ts).
 * A refusal there refuses the match with the Bokför step's code before
 * anything is written.
 *
 * Posting port (step 2e): the payment verifikat, the generator's or the
 * person's own rows, goes through lib/posting and, while POSTING_EVENTS is
 * shadow or strict, records purchase.paid with the door's link basis and
 * the debt settled, linked to the draft before a voucher number is drawn.
 * A refusal names the structured error code the route answers with; one that
 * carries `error` is answered through errorResponse (a bookkeeping error, a
 * database error), the rest through errorResponseFromCode.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Logger } from '@/lib/logger'
import { bankBookingContext } from '@/lib/bookkeeping/bank-booking-context'
import { buildSupplierBankMatchLines, createSupplierBankMatchEntry } from '@/lib/bookkeeping/supplier-bank-match-entry'
import { actorUnattendedCeiling, debitTotal, unattendedCeilingRefusal } from '@/lib/bookkeeping/unattended-ceiling'
import { resolveSettlementAccount } from '@/lib/bookkeeping/settlement-account'
import { cancelOrphanedPaymentEntry } from '@/lib/bookkeeping/cancel-orphaned-entry'
import { findUnresolvableAccounts } from '@/lib/bookkeeping/account-validation'
import { bankLineStornoBusinessEvent } from '@/lib/bookkeeping/bank-line-business-events'
import { decideBankRowRebooking } from '@/lib/transactions/is-booked'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { planSupplierBankMatch, type SupplierBankMatchPlan } from '@/lib/invoices/apply-supplier-payment'
import { findFiscalPeriod } from '@/lib/bookkeeping/engine'
import { buildSupplierDescription, supplierInvoiceReference } from '@/lib/bookkeeping/supplier-invoice-description'
import {
  supplierInvoicePaymentBusinessEvent,
  type SupplierPaymentPostingContext,
} from '@/lib/bookkeeping/supplier-invoice-business-events'
import { postingPort } from '@/lib/posting/port'
import { AccountsNotInChartError, isBookkeepingError } from '@/lib/bookkeeping/errors'
import { anchorSupplierInvoiceDocument } from '@/lib/core/documents/supplier-invoice-underlag'
import { logMatchEvent, type MatchAction } from '@/lib/invoices/match-log'
import { clearSettledInvoiceSuggestions } from '@/lib/invoices/clear-settled-invoice-suggestions'
import { paidAtFromDate } from '@/lib/invoices/paid-at'
import { emitSupplierInvoicePaidIfSettled } from '@/lib/invoices/paid-events'
import { eventBus } from '@/lib/events/bus'
import type { CreateJournalEntryInput, CreateJournalEntryLineInput, SupplierInvoice, Transaction } from '@/types'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { MATCHABLE_SUPPLIER_INVOICE_STATUSES } from '@/lib/bookkeeping/matchable-statuses'
import { linkBasisColumns, linkBasisColumnsFor, type LinkBasisInput } from '@/lib/links/stamp'
import {
  bookRegistrationBeforeSettlement,
  planRegistrationBeforeSettlement,
} from '@/lib/supplier-invoices/registration-first'
import { checkAccountingMethod } from '@/lib/company/accounting-method'

/**
 * The transactions row as the doors read it (`select('*')`): the fields the
 * plan, the generators and the document propagation read are required, the
 * rest travels into the match_confirmed event's payload.
 */
export type SupplierBankMatchTransactionRow = Pick<
  Transaction,
  'id' | 'date' | 'amount' | 'currency' | 'amount_sek' | 'cash_account_id' | 'document_id' | 'journal_entry_id'
> &
  Partial<Transaction>

export interface BookSupplierBankMatchArgs {
  transaction: SupplierBankMatchTransactionRow
  /** With `supplier` and `items` embedded: the cash-method builder books the items. */
  invoice: SupplierInvoice
  /** Who books: the person confirming, or the user who approved the bank payment. */
  userId: string
  companyId: string
  log: Logger
  /** User-edited verifikat lines instead of the plan's generator; they must balance. */
  customLines?: CreateJournalEntryLineInput[] | null
  /** How the match was decided, for payment_match_log. */
  match: {
    action: Extract<MatchAction, 'matched' | 'auto_matched'>
    method: string
    confidence: number
    /** Merged into the log row's new_state next to the ledger figures. */
    newState?: Record<string, unknown>
  }
  /**
   * Why the bank line, the payment row and the verifikat are linked
   * (link_basis on each): user_confirmed for a person's match, the matching
   * rule for the debit of a signed payment order.
   */
  linkBasis: LinkBasisInput
  /**
   * A person confirmed reversing the row's own categorization verifikat
   * (the match dialog's "Återför och matcha", v1's storno_existing): it is
   * reversed (storno) and the payment books in its place. Unset, a booked
   * row is refused with MATCH_SI_TX_ALREADY_BOOKED, which says in
   * details.storno_allowed whether this flag would let it through. Never
   * reverses a samlingsverifikat, a split or a reconciliation link.
   */
  stornoExisting?: boolean
}

export type BookSupplierBankMatchResult =
  | {
      ok: true
      journalEntryId: string
      plan: SupplierBankMatchPlan
      /** The invoice as it stands after the settlement. */
      settledInvoice: SupplierInvoice
      paidAt: string | null
      /** The registration verifikat this match booked first (defer_invoice_booking), else null. */
      registrationJournalEntryId: string | null
    }
  | {
      ok: false
      /** A structured error code (lib/errors/structured-errors.ts). */
      code: string
      details?: Record<string, unknown>
      /** Set when the route answers through errorResponse(error) rather than the code. */
      error?: unknown
    }

export async function bookSupplierBankMatch(
  supabase: SupabaseClient,
  args: BookSupplierBankMatchArgs,
): Promise<BookSupplierBankMatchResult> {
  const { transaction, invoice, userId, companyId, log, customLines, match } = args
  const transactionId = transaction.id
  const supplierInvoiceId = invoice.id

  // Already booked? One answer for every caller, before anything else runs.
  const rebooking = await decideBankRowRebooking(supabase, companyId, transaction, {
    replace: args.stornoExisting === true,
  })
  if (rebooking.outcome === 'refuse') {
    return {
      ok: false,
      code: 'MATCH_SI_TX_ALREADY_BOOKED',
      details: {
        journal_entry_id: rebooking.journalEntryId,
        voucher: rebooking.voucher,
        via: rebooking.via,
        storno_allowed: rebooking.replaceable,
      },
    }
  }
  const replaced = rebooking.outcome === 'replace' ? rebooking : null

  // Fail closed (accounted#58): planned as faktureringsmetoden, a
  // kontantmetod invoice that was never booked would only clear 2440 and its
  // cost and ingående moms would never be booked.
  const method = checkAccountingMethod(
    await supabase
      .from('company_settings')
      .select('accounting_method')
      .eq('company_id', companyId)
      .single(),
  )
  if (!method.ok) {
    log.error('supplier bank match refused: accounting method unavailable', method.error)
    return { ok: false, code: method.code, details: method.details }
  }
  const { accountingMethod } = method

  // Credit the cash account THIS transaction actually belongs to, never a
  // company-wide "last used" preference: last_supplier_payment_account is
  // written by the manual mark-paid flow (e.g. a private-funds payment
  // booked to 2893) and has no relationship to which bank account a real,
  // matched transaction settled from. Reusing it here silently misbooked a
  // genuine 1930 bank payment to 2893 once a private payment had set that
  // sticky default.
  const paymentAccount = await resolveSettlementAccount(
    supabase,
    companyId,
    transaction.cash_account_id,
    log,
  )

  // A storno cannot be taken back, so every refusal the payment can still
  // meet runs before it: the account the generated rows credit must be in the
  // chart (custom lines name their own accounts, checked with their balance).
  if (replaced && !customLines) {
    const missingAccounts = await findUnresolvableAccounts(supabase, companyId, [paymentAccount])
    if (missingAccounts.length > 0) {
      return { ok: false, code: 'ACCOUNTS_NOT_IN_CHART', error: new AccountsNotInChartError(missingAccounts) }
    }
  }

  // One payment plan for every door that matches a bank row to a supplier
  // invoice (the dashboard POST, its preview, the v1 POST and the bank
  // payment order's own debit): the bank fee split (6570), the overshoot
  // guard, öresavrundning (3740), the SEK and kursdifferens resolution and
  // the kontantmetoden refusals. User-edited lines are not exempt: the ledger
  // update below comes from this plan. Refusing here, BEFORE any JE is
  // created, keeps a doomed match from burning a voucher number.
  const planned = planSupplierBankMatch({ invoice, transaction, accountingMethod })
  if (!planned.ok) {
    return { ok: false, code: planned.code, details: planned.details }
  }
  const { plan } = planned

  // Verifikat header description for user-edited lines; the entry generators
  // below write their own.
  const desc = buildSupplierDescription(
    'Utbetalning leverantörsfaktura',
    supplierInvoiceReference(invoice.supplier_invoice_number, invoice.arrival_number),
    invoice.supplier?.name || undefined,
  )

  // One open-period gate for every booking shape below: the entry generators
  // only return null for a date outside an open period, which the caller
  // could report as nothing better than a generic failure.
  const fiscalPeriodId = await findFiscalPeriod(supabase, companyId, transaction.date)
  if (!fiscalPeriodId) {
    return {
      ok: false,
      code: 'INVOICE_PAID_NO_FISCAL_PERIOD',
      details: { paymentDate: transaction.date },
    }
  }

  // User-edited lines must balance and name accounts the engine can resolve:
  // both refused before the registration and the storno below, which the
  // engine's own account refusal at posting would otherwise leave standing.
  if (customLines) {
    const totalDebit = customLines.reduce((s, l) => s + l.debit_amount, 0)
    const totalCredit = customLines.reduce((s, l) => s + l.credit_amount, 0)
    if (Math.round((totalDebit - totalCredit) * 100) !== 0 || totalDebit <= 0) {
      return {
        ok: false,
        code: 'INVOICE_PAID_LINES_UNBALANCED',
        details: { totalDebit, totalCredit },
      }
    }
    const unresolvable = await findUnresolvableAccounts(
      supabase,
      companyId,
      customLines.map((l) => l.account_number),
    )
    if (unresolvable.length > 0) {
      return { ok: false, code: 'ACCOUNTS_NOT_IN_CHART', error: new AccountsNotInChartError(unresolvable) }
    }
  }

  // An API key's unattended ceiling, on the payment verifikat, before the
  // registration or the storno below posts anything: the engine refuses it
  // at commit too, but by then those would stand without the payment (an FX
  // difference can put the payment above a bank amount within the ceiling).
  if (actorUnattendedCeiling() !== null) {
    const paymentLines = customLines ?? buildSupplierBankMatchLines(invoice, plan.booking, paymentAccount).lines
    const overCeiling = unattendedCeilingRefusal(debitTotal(paymentLines))
    if (overCeiling) return { ok: false, code: overCeiling.code, error: overCeiling }
  }

  // Faktureringsmetoden with defer_invoice_booking: an invoice registered
  // without its verifikat is booked first by the Bokför step, then paid. Its
  // dry run runs every check first, so a refusal books nothing.
  const opCtx = { supabase, companyId, userId, log }
  const registrationPlan = await planRegistrationBeforeSettlement(opCtx, invoice, {
    settlementDate: transaction.date,
  })
  if (!registrationPlan.ok) return registrationPlan
  const registration = await bookRegistrationBeforeSettlement(opCtx, registrationPlan)
  if (!registration.ok) return registration

  // The row's own categorization, which the person asked to replace: reversed
  // last, once nothing above can refuse. The engine releases the row (its
  // pointer, is_business and category) with the storno.
  if (replaced) {
    try {
      // Through the posting port: while POSTING_EVENTS is on, the storno
      // records ledger.storno of the bank line, user_created as on the
      // uncategorize door (the person chose this storno), dated the day.
      await postingPort.reverseJournalEntry({
        supabase,
        companyId,
        userId,
        entryId: replaced.journalEntryId,
        event: () => bankLineStornoBusinessEvent(transactionId, todayIsoStockholm(), linkBasisColumns('user_created')),
        role: 'reversal',
      })
    } catch (err) {
      log.error('supplier bank match: storno of the row\'s own booking failed', err as Error, {
        journalEntryId: replaced.journalEntryId,
      })
      return { ok: false, code: 'MATCH_SI_JE_FAILED', error: err }
    }
    await logMatchEvent(supabase, userId, transactionId, 'storno_conflict_resolved', {
      supplierInvoiceId,
      previousState: { journal_entry_id: replaced.journalEntryId },
      newState: { journal_entry_id: null },
    })
  }

  let journalEntryId: string | null = null
  // The door's side of the purchase.paid event, read only while the port is on.
  const posting = (): SupplierPaymentPostingContext => ({
    linkBasis: linkBasisColumnsFor(args.linkBasis),
    settledAmount: plan.settledAmount,
  })

  try {
    if (customLines) {
      const sourceType = plan.booking.kind === 'cash' ? 'supplier_invoice_cash_payment' : 'supplier_invoice_paid'
      const input: CreateJournalEntryInput = {
        fiscal_period_id: fiscalPeriodId,
        entry_date: transaction.date,
        description: desc,
        source_type: sourceType,
        source_id: invoice.id,
        bank_booking_context: [bankBookingContext(transaction, paymentAccount)],
        lines: customLines,
      }
      const journalEntry = await postingPort.postJournalEntry({
        supabase,
        companyId,
        userId,
        event: () =>
          supplierInvoicePaymentBusinessEvent(invoice, input, { paymentAccount, generated: false, bankLine: true }, posting()),
        input,
      })
      if (journalEntry) journalEntryId = journalEntry.id
    } else {
      // The generator the plan names, with every input it carries (the 6570
      // fee and the 3740 SEK clearing debt included): the same call the v1
      // door books with, and the lines the preview shows.
      const journalEntry = await createSupplierBankMatchEntry(supabase, companyId, userId, {
        invoice,
        booking: plan.booking,
        paymentAccount,
        transaction,
        posting,
      })
      if (journalEntry) journalEntryId = journalEntry.id
    }
  } catch (err) {
    log.error('failed to create supplier invoice payment journal entry', err as Error)
    // A failed payment voucher must fail the whole match. Proceeding used to
    // mark the invoice paid with NO voucher: an unrecoverable half-state:
    // mark-paid rejects 'paid' invoices and the match route rejects linked
    // transactions, so no flow could ever complete the booking afterwards.
    // The cash-method builder converts every leg through toSekOrThrow, so a
    // foreign invoice with no usable rate surfaces here as
    // SupplierInvoiceFxRateMissingError. Dispatch on its `code` (not
    // instanceof: the class is routinely vi.mock'ed away) so errorResponse
    // maps it to the registered 400 "ange fakturans växelkurs" entry instead
    // of a generic 500. Same code the preview returns for the same row.
    if ((err as { code?: unknown })?.code === 'SI_FX_RATE_MISSING') {
      return { ok: false, code: 'SI_FX_RATE_MISSING', error: err }
    }
    if (isBookkeepingError(err)) {
      const code = (err as { code?: unknown }).code
      return { ok: false, code: typeof code === 'string' ? code : 'MATCH_SI_JE_FAILED', error: err }
    }
    return {
      ok: false,
      code: 'MATCH_SI_JE_FAILED',
      details: { reason: err instanceof Error ? getUserErrorMessage(err) : 'unknown' },
    }
  }

  if (!journalEntryId) {
    return { ok: false, code: 'MATCH_SI_JE_FAILED' }
  }
  const paymentEntryId = journalEntryId

  // Claim the bank row right after its payment verifikat posts, as a
  // compare-and-set on what the gate read: a concurrent booking or match of
  // the row (a categorization, the payment order's own debit, a second tab)
  // makes this a no-op, and the verifikat just posted is cancelled instead
  // of standing next to the other booking. The pointer the gate let through
  // is null, a verifikat no longer posted, or the categorization reversed
  // above, which the storno released to null.
  const readPointer = transaction.journal_entry_id ?? null
  // Two literal compare-and-sets, not one interpolated .or(): the pointer
  // the gate read first, then none. Each is atomic, and the second only runs
  // when the first matched nothing, so the pair claims exactly what
  // "null or the pointer read" claims, and the phantom-column guard can
  // check both.
  const claimRow = (pointer: string | null) => {
    const claim = supabase
      .from('transactions')
      .update({
        supplier_invoice_id: supplierInvoiceId,
        // Clear the suggestion now that it is a confirmed link, mirroring the
        // customer-invoice route. Leaving it set kept a pointer at an invoice
        // this very request marks paid, i.e. the stale-pointer state every
        // read path now has to defend against.
        potential_supplier_invoice_id: null,
        journal_entry_id: paymentEntryId,
        is_business: true,
        // The payment is the row's booking now, not a reconciliation link. A
        // literal so the phantom-column scanner can verify the column set.
        reconciliation_method: null,
        ...linkBasisColumnsFor(args.linkBasis),
      })
      .eq('id', transactionId)
      .eq('company_id', companyId)
      .is('supplier_invoice_id', null)
    return (pointer ? claim.eq('journal_entry_id', pointer) : claim.is('journal_entry_id', null)).select('id')
  }
  let claimed = await claimRow(readPointer)
  if (readPointer && !claimed.error && !claimed.data?.length) claimed = await claimRow(null)
  const { data: claimedRows, error: claimError } = claimed

  if (claimError || !claimedRows || claimedRows.length === 0) {
    await cancelOrphanedPaymentEntry(
      supabase, companyId, userId, paymentEntryId,
      'Automatiskt makulerad: dubblettbokning förhindrad av samtidighetsskydd',
    )
    if (claimError) {
      log.error('failed to link transaction to supplier invoice', claimError)
      return { ok: false, code: 'MATCH_SI_LINK_TX_FAILED' }
    }
    return {
      ok: false,
      code: 'MATCH_SI_TX_ALREADY_BOOKED',
      details: { journal_entry_id: null, voucher: null, via: 'concurrent', storno_allowed: false },
    }
  }

  // Undo what this call wrote after the payment verifikat, newest first, and
  // cancel the verifikat: a match that stops here must leave neither a
  // payment verifikat with no payment nor an invoice settled by a cancelled
  // one. Each write is a compare-and-set on this call's own verifikat, so
  // nothing a concurrent request wrote is touched. Never throws.
  const unwind = async (explanation: string, opts: { invoice: boolean }) => {
    if (opts.invoice) {
      const { error } = await supabase
        .from('supplier_invoices')
        .update({
          status: invoice.status,
          remaining_amount: invoice.remaining_amount,
          paid_amount: invoice.paid_amount,
          paid_at: invoice.paid_at ?? null,
          payment_journal_entry_id: invoice.payment_journal_entry_id ?? null,
          transaction_id: invoice.transaction_id ?? null,
        })
        .eq('id', supplierInvoiceId)
        .eq('company_id', companyId)
        .eq('payment_journal_entry_id', paymentEntryId)
      if (error) log.error('supplier bank match: invoice ledger update not undone', error, { journalEntryId: paymentEntryId })
    }
    const { error: releaseError } = await supabase
      .from('transactions')
      .update({
        supplier_invoice_id: null,
        potential_supplier_invoice_id: transaction.potential_supplier_invoice_id ?? null,
        journal_entry_id: null,
        is_business: replaced ? null : (transaction.is_business ?? null),
      })
      .eq('id', transactionId)
      .eq('company_id', companyId)
      .eq('journal_entry_id', paymentEntryId)
    if (releaseError) log.error('supplier bank match: bank row not released', releaseError, { journalEntryId: paymentEntryId })
    await cancelOrphanedPaymentEntry(supabase, companyId, userId, paymentEntryId, explanation)
  }

  // Ledger update from the plan computed up front. An öre-absorbed settlement
  // reports remaining 0 / status paid even though the bank paid a sub-krona
  // less (or more): the residual lives on 3740, not the supplier ledger.
  const { newRemaining, newPaidAmount, isFullyPaid, newStatus, settledAmount } = plan
  const paidAt = isFullyPaid ? paidAtFromDate(transaction.date) : null

  const { data: updatedRows, error: updateInvError } = await supabase
    .from('supplier_invoices')
    .update({
      status: newStatus,
      remaining_amount: newRemaining,
      paid_amount: newPaidAmount,
      paid_at: paidAt,
      payment_journal_entry_id: paymentEntryId,
      transaction_id: transactionId,
    })
    .eq('id', supplierInvoiceId)
    .eq('company_id', companyId)
    .in('status', [...MATCHABLE_SUPPLIER_INVOICE_STATUSES])
    .select('id')

  if (updateInvError) {
    log.error('failed to update supplier invoice', updateInvError)
    await unwind('Automatiskt makulerad: matchningen kunde inte sparas', { invoice: false })
    return { ok: false, code: 'MATCH_SI_INVOICE_UPDATE_FAILED', error: updateInvError }
  }

  if (!updatedRows || updatedRows.length === 0) {
    // CAS guard: the invoice was settled by a concurrent request between
    // our read and write. The payment voucher we just posted belongs to no
    // payment: release the row, cancel the voucher and document the gap
    // (mirrors mark-paid).
    await unwind('Automatiskt makulerad: dubblettbokning förhindrad av samtidighetsskydd', { invoice: false })
    return { ok: false, code: 'MATCH_SI_NOT_OPEN' }
  }

  const { error: paymentInsertError } = await supabase
    .from('supplier_invoice_payments')
    .insert({
      user_id: userId,
      company_id: companyId,
      supplier_invoice_id: supplierInvoiceId,
      payment_date: transaction.date,
      // Payment rows reconstruct and reverse paid_amount, so store the debt
      // settled, including any 3740 adjustment. Actual cash stays on the
      // linked bank transaction and the payment account's journal line.
      amount: settledAmount,
      currency: invoice.currency,
      journal_entry_id: paymentEntryId,
      transaction_id: transactionId,
      ...linkBasisColumnsFor(args.linkBasis),
    })

  if (paymentInsertError) {
    // 23505: this row already pays this invoice. Either way the payment is
    // not recorded, so nothing this call wrote may stay: it used to leave
    // the payment verifikat posted and the invoice settled by it.
    await unwind('Automatiskt makulerad: betalningen kunde inte registreras på leverantörsfakturan', { invoice: true })
    if (paymentInsertError.code === '23505') {
      return { ok: false, code: 'MATCH_SI_DUPLICATE_PAYMENT' }
    }
    log.error('failed to record supplier invoice payment', paymentInsertError)
    return { ok: false, code: 'MATCH_SI_RECORD_PAYMENT_FAILED' }
  }

  // The invoice is now settled, so every OTHER transaction still carrying a
  // suggestion pointer at it is dead: retire them (issue #1259). This
  // request's own row was cleared by the claim above.
  if (isFullyPaid) {
    await clearSettledInvoiceSuggestions(
      supabase,
      companyId,
      'supplier_invoice',
      supplierInvoiceId,
      { exceptTransactionId: transactionId },
    )
  }

  // Propagate a document pinned to the transaction (via /attach-document or
  // MCP) onto the payment verifikat, mirroring the categorize route (BFL
  // 5 kap 6 §: the verifikation must reference its underlag). Guarded to
  // unlinked current-version docs only: a doc already serving another
  // verifikat (e.g. the supplier invoice's own document on the registration
  // entry) must not move. Non-fatal: the match is already committed.
  if (transaction.document_id) {
    const { error: docLinkError } = await supabase
      .from('document_attachments')
      .update({
        journal_entry_id: journalEntryId,
        // Follows from the row's pinned document and the match, not chosen as a pair.
        ...linkBasisColumns('system_derived', { rule_id: 'bank_row_document_pin' }),
      })
      .eq('id', transaction.document_id)
      .eq('company_id', companyId)
      .is('journal_entry_id', null)
      .eq('is_current_version', true)
    if (docLinkError) {
      // Structured fields so the half-linked state (doc retained but not
      // anchored to the payment JE) can be reconstructed without an audit
      // trail dig.
      log.warn('failed to link transaction document to payment JE (non-critical)', {
        error: docLinkError,
        documentId: transaction.document_id,
        journalEntryId,
      })
    }
  }

  // Same requirement one table over: the SUPPLIER INVOICE's own retained
  // document must sit on a posted verifikat, or the payment verifikat we
  // just booked shows the invoice PDF while every missing-underlag surface
  // (which only accepts an anchored doc) warns "Underlag saknas". No-op when
  // it is already anchored, e.g. on the registration verifikat.
  await anchorSupplierInvoiceDocument(supabase, companyId, supplierInvoiceId)

  await logMatchEvent(supabase, userId, transactionId, match.action, {
    supplierInvoiceId,
    matchConfidence: match.confidence,
    matchMethod: match.method,
    newState: {
      status: newStatus,
      paid_amount: newPaidAmount,
      remaining_amount: newRemaining,
      ...(match.newState ?? {}),
    },
  })

  const settledInvoice = {
    ...invoice,
    status: newStatus,
    remaining_amount: newRemaining,
    paid_amount: newPaidAmount,
    paid_at: paidAt,
    payment_journal_entry_id: journalEntryId,
    transaction_id: transactionId,
  } as SupplierInvoice
  try {
    await eventBus.emit({
      type: 'supplier_invoice.match_confirmed',
      payload: {
        supplierInvoice: settledInvoice,
        transaction: {
          ...transaction,
          supplier_invoice_id: supplierInvoiceId,
          potential_supplier_invoice_id: null,
          journal_entry_id: journalEntryId,
          is_business: true,
        } as Transaction,
        userId,
        companyId,
      },
    })
  } catch (err) {
    log.warn('supplier_invoice.match_confirmed event emission failed', err as Error)
  }
  // A match that settles the invoice in full is its supplier_invoice.paid
  // transition; a partial match is not. The CAS update above admits one
  // winner, so this fires once. paymentAmount is the debt settled, in
  // invoice currency, same as the payment row.
  await emitSupplierInvoicePaidIfSettled({
    newStatus,
    supplierInvoice: settledInvoice,
    paymentAmount: settledAmount,
    userId,
    companyId,
  })

  return {
    ok: true,
    journalEntryId,
    plan,
    settledInvoice,
    paidAt,
    registrationJournalEntryId: registration.bookedHere ? registration.journalEntryId : null,
  }
}
