/**
 * Book one bank receipt as the payment of one customer invoice: the whole
 * settlement behind every door that matches them, as one function, the twin
 * of bookSupplierBankMatch.
 *
 * The doors only parse their input and map this outcome: the dashboard match
 * route, its v1 twin, and the approval of a staged match
 * (gnubok_match_transaction_to_invoice, which gnubok_auto_match_period
 * stages). They used to be three copies of this sequence, each with its own
 * subset of the guards, so a fix reached the copies its author touched: only
 * the dashboard knew an active credit note, only the approval logged no match
 * and carried no invoice PDF, and each one reversed or overwrote a booked row
 * in its own way.
 *
 * The order: every refusal first, on reads only (refuseCustomerBankMatch, the
 * duplicate guard, the payment plan, the kontantmetoden and period gates, the
 * verifikat's rows and their accounts, the sale's dry run), then the writes:
 * the sale a deferring company books first, the payment verifikat through the
 * engine, the bank row claimed behind a compare-and-set, the invoice behind a
 * status compare-and-set, the invoice_payments row, then the retired
 * suggestions, the invoice PDF and the row's own underlag on the verifikat
 * (propagateUnderlagForBookedTransaction), the match log and the events.
 *
 * A bank row that is already booked or ignored is refused, for every caller:
 * the founders chose refusal over silent replacement on the supplier side
 * (accounted#58, 2026-10-28), and matching such a row here posted a second
 * payment verifikat, so one 1500 kr row moved 1930 by 3000 kr, or reversed an
 * independent verifikat an approval never named. Nothing is reversed here:
 * whoever wants to replace a booking undoes it first, and the refusal says how
 * (details.undo, BankRowUndo in lib/transactions/is-booked.ts).
 *
 * A match that stops after the payment verifikat posted undoes its own writes
 * and cancels the verifikat. Only the sale stays: it is a correct booking of
 * the sent invoice whatever happens to the match, so every later failure
 * names it (details.posted_ids, partialPostedIds).
 */
import { bankBookingContext } from '@/lib/bookkeeping/bank-booking-context'
import { findUnresolvableAccounts } from '@/lib/bookkeeping/account-validation'
import { cashPartialBlockReason } from '@/lib/bookkeeping/booking-mode'
import { cancelOrphanedPaymentEntry } from '@/lib/bookkeeping/cancel-orphaned-entry'
import { findFiscalPeriod } from '@/lib/bookkeeping/engine'
import { AccountsNotInChartError, isBookkeepingError } from '@/lib/bookkeeping/errors'
import { invoicePaymentBusinessEvent, type InvoicePaymentPostingContext } from '@/lib/bookkeeping/invoice-business-events'
import { buildInvoiceCashLines, createInvoiceCashEntry } from '@/lib/bookkeeping/invoice-entries'
import { invoiceCashBankSek } from '@/lib/bookkeeping/invoice-lines'
import { buildInvoiceMatchClearingLines, invoiceMatchPaymentDescription } from '@/lib/bookkeeping/invoice-payment-lines'
import { carriedSekOf } from '@/lib/bookkeeping/ledger-carried-sek'
import { MATCHABLE_INVOICE_STATUSES, isMatchableInvoiceStatus } from '@/lib/bookkeeping/matchable-statuses'
import { resolveSettlementAccount } from '@/lib/bookkeeping/settlement-account'
import { actorUnattendedCeiling, debitTotal, unattendedCeilingRefusal } from '@/lib/bookkeeping/unattended-ceiling'
import { checkAccountingMethod } from '@/lib/company/accounting-method'
import { resolveCompanyEntityType } from '@/lib/company/entity-type'
import { releaseDoubtfulReserveAfterChange } from '@/lib/customer-loss/doubtful'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { eventBus } from '@/lib/events/bus'
import { guardDuplicatePaymentVoucher, recordDuplicateCandidateOverride } from '@/lib/invoices/already-explained-guard'
import { clearSettledInvoiceSuggestions } from '@/lib/invoices/clear-settled-invoice-suggestions'
import { invoiceDocumentRefusal, type InvoiceDocumentFields } from '@/lib/transactions/invoice-document-refusal'
import { recordInvoicePaymentRow } from '@/lib/invoices/invoice-payment-row'
import { logMatchEvent } from '@/lib/invoices/match-log'
import { planTransactionInvoiceMatch } from '@/lib/invoices/match-payment-plan'
import { paidAtFromDate } from '@/lib/invoices/paid-at'
import { emitInvoicePaidIfSettled } from '@/lib/invoices/paid-events'
import {
  bookSaleBeforeSettlement,
  clearsReceivable,
  planSaleBeforeSettlement,
  SALE_FIRST_NOT_REQUIRED,
} from '@/lib/invoices/sale-first'
import { linkBasisColumns } from '@/lib/links/stamp'
import { roundOre } from '@/lib/money'
import { lineBalance } from '@/lib/bookkeeping/line-balance'
import type { OperationContext, OperationOutcome, OperationWarning } from '@/lib/operations/types'
import { postingPort } from '@/lib/posting/port'
import { propagateUnderlagForBookedTransaction } from '@/lib/transactions/inbox-underlag'
import { bankRowRefusalCode, decideBankRowRebooking } from '@/lib/transactions/is-booked'
import type { CreateJournalEntryInput, CreateJournalEntryLineInput, Invoice, Transaction } from '@/types'

export type CustomerBankMatchRefusal = Extract<OperationOutcome<never>, { ok: false }>

/** The bank row and the invoice as refuseCustomerBankMatch reads them. */
export interface CustomerMatchRow {
  id: string
  amount: number
  invoice_id?: string | null
  journal_entry_id: string | null
  reconciliation_method?: string | null
  is_ignored?: boolean | null
}

export type CustomerMatchInvoice = InvoiceDocumentFields & { id: string; status: string }

export interface BookCustomerBankMatchArgs {
  transactionId: string
  invoiceId: string
  /** User-edited verifikat rows instead of the generator's; they must balance. */
  customLines?: CreateJournalEntryLineInput[] | null
  /** The rate off the bank statement, when Riksbanken has none for the date. */
  manualExchangeRate?: number
  /** Where a SEK excess of a krona or more goes (crm#1045). */
  overpaymentAccount?: string
  /** The excess the caller was shown: booked exactly, or MATCH_OVERPAYMENT_CHANGED. */
  overpaymentAmount?: number
  /** The account for a payment provider's fee withheld from the payout (crm#1364). */
  feeAccount?: string
  /** The fee the caller was shown: booked exactly, or MATCH_PAYMENT_FEE_CHANGED. */
  feeAmount?: number
  /** Override MATCH_INVOICE_POSSIBLE_DUPLICATE, bound to the candidate the caller saw. */
  force?: boolean
  expectedJournalEntryId?: string
  /** Which door honoured the override, for behandlingshistorik. */
  overrideVia: string
}

export interface BookedCustomerBankMatch {
  ok: true
  journalEntryId: string
  invoiceStatus: 'paid' | 'partially_paid'
  paidAt: string | null
  paidAmount: number
  remainingAmount: number
  /** The row's own category: a match never guesses one. */
  category: string | null
  /** The sale verifikat this match booked first (defer_invoice_booking), else null. */
  saleJournalEntryId: string | null
  saleWarnings: OperationWarning[]
  overpayment: { account: string; amount: number } | null
  fee: { account: string; amount: number } | null
}

export type BookCustomerBankMatchResult = BookedCustomerBankMatch | CustomerBankMatchRefusal

/** An expense row, or a row with an invoice, can be matched to no invoice. */
function rowRefusal(transaction: Pick<CustomerMatchRow, 'amount' | 'invoice_id'>): CustomerBankMatchRefusal | null {
  if (transaction.amount <= 0) {
    return { ok: false, code: 'MATCH_INVOICE_NOT_INCOME', details: { amount: transaction.amount } }
  }
  if (transaction.invoice_id) {
    return { ok: false, code: 'MATCH_INVOICE_TX_ALREADY_LINKED', details: { existingInvoiceId: transaction.invoice_id } }
  }
  return null
}

/**
 * Every refusal that reads only the bank row and the invoice, for the booking
 * below and for the MCP stagings, so a match the approval would refuse is
 * refused when it is staged. The row must be an income row with no invoice,
 * open by the gate every booking door shares (decideBankRowRebooking); the
 * invoice a faktura, with no credit note against it, open, and without a
 * payment verifikat its status leaked past.
 */
export async function refuseCustomerBankMatch(
  ctx: Pick<OperationContext, 'supabase' | 'companyId'>,
  transaction: CustomerMatchRow,
  invoice: CustomerMatchInvoice,
): Promise<CustomerBankMatchRefusal | null> {
  const { supabase, companyId } = ctx
  const row = rowRefusal(transaction)
  if (row) return row
  const document = invoiceDocumentRefusal(invoice)
  if (document) return { ok: false, ...document }
  if (!isMatchableInvoiceStatus(invoice.status)) {
    return { ok: false, code: 'MATCH_INVOICE_NOT_OPEN', details: { currentStatus: invoice.status } }
  }

  const rebooking = await decideBankRowRebooking(supabase, companyId, transaction, { replace: false })
  if (rebooking.outcome === 'refuse') {
    return {
      ok: false,
      code: bankRowRefusalCode(rebooking, 'MATCH_INVOICE_TX_ALREADY_BOOKED'),
      details: {
        journal_entry_id: rebooking.journalEntryId,
        voucher: rebooking.voucher,
        via: rebooking.via,
        undo: rebooking.undo,
      },
    }
  }

  // Hard-duplicate guard: the invoice reads 'sent' or 'overdue' but already
  // has a payment voucher attached (a status leak). Booking again would
  // double-credit 1510 and double-debit 1930. Partially paid invoices pass:
  // further payments are legitimate.
  if (invoice.status === 'sent' || invoice.status === 'overdue') {
    const { data: existingPayments } = await supabase
      .from('invoice_payments')
      .select('journal_entry_id')
      .eq('company_id', companyId)
      .eq('invoice_id', invoice.id)
      .not('journal_entry_id', 'is', null)
      .limit(1)
    if (existingPayments && existingPayments.length > 0) {
      return {
        ok: false,
        code: 'MATCH_INVOICE_ALREADY_HAS_PAYMENT_VOUCHER',
        details: {
          existing_journal_entry_id: (existingPayments[0] as { journal_entry_id: string }).journal_entry_id,
        },
      }
    }
  }
  return null
}

export async function bookCustomerBankMatch(
  ctx: OperationContext,
  args: BookCustomerBankMatchArgs,
): Promise<BookCustomerBankMatchResult> {
  const { supabase, companyId, userId, log } = ctx
  const { transactionId, invoiceId, customLines } = args

  const { data: transactionRow, error: fetchTxError } = await supabase
    .from('transactions')
    .select('*')
    .eq('id', transactionId)
    .eq('company_id', companyId)
    .single()
  if (fetchTxError || !transactionRow) return { ok: false, code: 'TX_CATEGORIZE_TX_NOT_FOUND' }
  const transaction = transactionRow as Transaction
  const row = rowRefusal(transaction)
  if (row) return row

  const { data: invoiceRow, error: fetchInvError } = await supabase
    .from('invoices')
    .select('*, customer:customers(*), items:invoice_items(*), credit_notes:invoices!credited_invoice_id(id, status, creation_complete)')
    .eq('id', invoiceId)
    .eq('company_id', companyId)
    .single()
  if (fetchInvError || !invoiceRow) return { ok: false, code: 'MATCH_INVOICE_NOT_FOUND' }
  const invoice = invoiceRow as Invoice & CustomerMatchInvoice & { customer?: { name?: string | null } | null }

  const refused = await refuseCustomerBankMatch(ctx, transaction, invoice)
  if (refused) return refused

  // Soft-duplicate guard: a manual verifikation that already books this
  // receipt (Dr 1930 / Cr 3100 by hand) would be booked a second time. force
  // is bound to the candidate the caller saw: re-detected here, a stale or
  // guessed id cannot wave the guard away. A failed detection continues
  // without force and refuses with it: an override that cannot be re-verified
  // is not honoured.
  const duplicate = await guardDuplicatePaymentVoucher(
    supabase,
    companyId,
    transaction,
    { force: args.force === true, expected_journal_entry_id: args.expectedJournalEntryId },
    { onDetectError: (err) => log.warn('customer bank match: duplicate detection failed', err as Error) },
  )
  if (duplicate.status === 'blocked') {
    return { ok: false, code: 'MATCH_INVOICE_POSSIBLE_DUPLICATE', details: { candidate: duplicate.candidate } }
  }
  if (duplicate.status === 'mismatch') {
    return {
      ok: false,
      code: 'MATCH_INVOICE_FORCE_CANDIDATE_MISMATCH',
      details: {
        expected_journal_entry_id: duplicate.expected_journal_entry_id,
        detected_journal_entry_id: duplicate.detected_journal_entry_id,
      },
    }
  }

  // FX resolution, overshoot guard and paid/remaining math: one plan with the
  // stagings and the preview's steps, so a dialog never shows a booking this
  // refuses. Pure-SEK settlements absorb sub-krona öresavrundning (3740); an
  // excess of a krona or more books only on the account the caller named
  // (crm#1045), and a payout short of the invoice by a provider's fee settles
  // it in full only when the caller named it one (6570, crm#1364).
  const matchPlan = await planTransactionInvoiceMatch(supabase, transaction, invoice, {
    overpaymentAccount: args.overpaymentAccount,
    feeAccount: args.feeAccount,
    manualExchangeRate: args.manualExchangeRate,
  })
  if (!matchPlan.ok) {
    switch (matchPlan.code) {
      case 'MATCH_INVOICE_TX_FX_RATE_MISSING':
        return {
          ok: false,
          code: matchPlan.code,
          details: { transaction_currency: transaction.currency, transaction_date: transaction.date },
        }
      case 'MATCH_INVOICE_FX_RATE_UNAVAILABLE':
        return {
          ok: false,
          code: matchPlan.code,
          details: {
            transaction_currency: transaction.currency,
            invoice_currency: invoice.currency,
            payment_date: transaction.date,
          },
        }
      default:
        return { ok: false, code: matchPlan.code, details: { currency: matchPlan.currency, ...matchPlan.details } }
    }
  }
  // The caller was shown one excess and one fee: book those or nothing. A
  // payment applied to the invoice since would otherwise book another amount
  // than the one confirmed.
  const shownExcess = args.overpaymentAmount === undefined ? 0 : roundOre(args.overpaymentAmount)
  const currentExcess = matchPlan.overpayment?.amount ?? 0
  if (shownExcess !== currentExcess) {
    return { ok: false, code: 'MATCH_OVERPAYMENT_CHANGED', details: { shown_excess: shownExcess, current_excess: currentExcess } }
  }
  const shownFee = args.feeAmount === undefined ? 0 : roundOre(args.feeAmount)
  const currentFee = matchPlan.fee?.amount ?? 0
  if (shownFee !== currentFee) {
    return { ok: false, code: 'MATCH_PAYMENT_FEE_CHANGED', details: { shown_fee: shownFee, current_fee: currentFee } }
  }
  const { fx } = matchPlan
  const overpaymentAccount = matchPlan.overpayment?.account
  const feeAccount = matchPlan.fee?.account
  const { newPaidAmount, newRemaining, isFullyPaid, newStatus } = matchPlan.plan
  const paidAt = isFullyPaid ? paidAtFromDate(transaction.date) : null

  // Fail closed (accounted#58): planned as faktureringsmetoden, a kontantmetod
  // invoice that was never booked would only clear 1510.
  const settingsRead = await supabase
    .from('company_settings')
    .select('accounting_method, entity_type')
    .eq('company_id', companyId)
    .single()
  const method = checkAccountingMethod(settingsRead)
  if (!method.ok) {
    log.error('customer bank match refused: accounting method unavailable', method.error)
    return { ok: false, code: method.code, details: method.details }
  }
  const { accountingMethod } = method
  const entityType = await resolveCompanyEntityType(supabase, companyId, settingsRead.data?.entity_type)

  // Debit the cash account THIS transaction belongs to, never a hardcoded
  // 1930: a receipt into a secondary SEK account or a foreign-currency
  // account must book there, or the ledger silently diverges from the bank
  // statement it represents (BFL 5 kap 1-2 §).
  const paymentAccount = await resolveSettlementAccount(supabase, companyId, transaction.cash_account_id, log)

  // The verifikat's shape follows the INVOICE'S booking state, not the
  // company's current setting: an invoice booked at send (Dr 1510 / Cr 30xx +
  // VAT) must clear 1510, or the receivable stays orphaned and revenue and
  // VAT are counted twice. Only an invoice with no verifikat on a
  // kontantmetod company recognises revenue and VAT at payment.
  const invoiceAlreadyBooked = !!invoice.journal_entry_id
  const useCashEntry = !invoiceAlreadyBooked && accountingMethod === 'cash' && isFullyPaid

  // The cash entry books the FULL total and never touches 1510, so a partial
  // payment or a part-paid completion of a never-booked invoice has no shape
  // here. On an invoice booked under accrual the clearing entry IS the
  // partial path, whatever the current setting.
  const cashBlock = cashPartialBlockReason({
    invoiceAlreadyBooked,
    accountingMethod,
    priorPaidAmount: invoice.paid_amount,
    paysRemainingInFull: isFullyPaid,
  })
  if (cashBlock) {
    return {
      ok: false,
      code: 'INVOICE_PAID_CASH_PARTIAL_UNSUPPORTED',
      details: { reason: cashBlock, payment_amount: matchPlan.paidAmount, invoice_total: invoice.total },
    }
  }

  if (customLines) {
    const { balanced, totalDebit, totalCredit } = lineBalance(customLines)
    if (!balanced) {
      return { ok: false, code: 'INVOICE_PAID_LINES_UNBALANCED', details: { totalDebit, totalCredit } }
    }
  }

  // One open period for every booking shape: the cash builder alone returns
  // null for a closed one, which could only be reported as a generic failure.
  const fiscalPeriodId = await findFiscalPeriod(supabase, companyId, transaction.date)
  if (!fiscalPeriodId) {
    return { ok: false, code: 'INVOICE_PAID_NO_FISCAL_PERIOD', details: { payment_date: transaction.date } }
  }

  // What stands after a failure: the sale once booked, and a payment verifikat
  // that could not be cancelled. A partial commit, never a clean refusal.
  const postedIds: Record<string, string> = {}
  const withPosted = (failure: CustomerBankMatchRefusal): CustomerBankMatchRefusal =>
    Object.keys(postedIds).length > 0
      ? {
          ...failure,
          details: { ...(failure.details ?? {}), ...postedIds, posted_ids: { ...postedIds } },
          partialPostedIds: { ...postedIds },
        }
      : failure
  const cancelPaymentEntry = async (paymentEntryId: string, explanation: string) => {
    const cancelled = await cancelOrphanedPaymentEntry(supabase, companyId, userId, paymentEntryId, explanation)
    if (!cancelled) postedIds.payment_journal_entry_id = paymentEntryId
  }
  const bookingFailure = (err: unknown): CustomerBankMatchRefusal => {
    if (err instanceof AccountsNotInChartError) {
      return withPosted({ ok: false, code: err.code, error: err, details: { account_numbers: err.accountNumbers } })
    }
    // A foreign invoice with no booking rate is a missing input, fully
    // retryable once the rate is on file. Dispatch on `code`, not instanceof:
    // the class lives in a module route tests routinely vi.mock away. Typed
    // bookkeeping errors (period locked, above an API key's ceiling) keep
    // their registered envelope the same way.
    const code = (err as { code?: unknown })?.code
    if (code === 'MATCH_INVOICE_BOOKING_RATE_MISSING' || code === 'INVOICE_FX_RATE_MISSING' || isBookkeepingError(err)) {
      return withPosted({ ok: false, code: typeof code === 'string' ? code : 'INVOICE_PAID_BOOK_FAILED', error: err })
    }
    log.error('customer bank match: the payment verifikat failed', err as Error, { postedIds })
    return withPosted({
      ok: false,
      code: 'INVOICE_PAID_BOOK_FAILED',
      details: { reason: getErrorMessage(err, { context: 'invoice' }) },
    })
  }

  // Faktureringsmetoden with defer_invoice_booking: an invoice sent without
  // its verifikat gets its sale booked first, by the Bokför step on its
  // invoice date, and the payment then clears the 1510 it debits. The plan is
  // that step's dry run and the payment date's lock, so a refusal comes
  // before anything is written. Edited rows that book the revenue themselves
  // carry the sale already.
  const salePlan =
    customLines && !clearsReceivable(customLines)
      ? SALE_FIRST_NOT_REQUIRED
      : await planSaleBeforeSettlement(ctx, invoice, { settlementDate: transaction.date })
  if (!salePlan.ok) return salePlan

  // The rows, built up front so the builders' own refusals and the chart
  // check come before anything is written: the same builders the booking
  // uses and the preview shows, the invoice's dimensions on every leg.
  const description = invoiceMatchPaymentDescription(invoice)
  let paymentLines: CreateJournalEntryLineInput[]
  try {
    const carriedSek =
      customLines || useCashEntry
        ? null
        : salePlan.required
          ? salePlan.receivableSek
          : await carriedSekOf(supabase, companyId, 'customer', invoice)
    paymentLines = customLines
      ? customLines
      : useCashEntry
        ? buildInvoiceCashLines(
            invoice,
            entityType,
            invoice.customer?.name ?? undefined,
            paymentAccount,
            // The bank amount createInvoiceCashEntry derives from the same row.
            invoiceCashBankSek(transaction),
            overpaymentAccount,
            { deferDeductionShare: accountingMethod === 'cash', feeAccount },
          ).lines
        : buildInvoiceMatchClearingLines(
            {
              amount: transaction.amount,
              amount_sek: transaction.amount_sek ?? null,
              currency: transaction.currency,
              exchange_rate: transaction.exchange_rate ?? null,
            },
            {
              currency: invoice.currency,
              exchange_rate: invoice.exchange_rate ?? null,
              remaining_amount: invoice.remaining_amount ?? null,
              total: invoice.total,
              paid_amount: invoice.paid_amount ?? null,
              carried_sek: carriedSek,
              invoice_number: invoice.invoice_number,
              customer: invoice.customer,
              default_dimensions: (invoice as { default_dimensions?: unknown }).default_dimensions,
            },
            // Cross-currency: the converted invoice-currency amount, so 1510
            // is credited proportionally and the FX difference is posted.
            fx.required ? fx.paidInInvoiceCurrency : undefined,
            paymentAccount,
            overpaymentAccount,
            feeAccount,
          ).lines
  } catch (err) {
    return bookingFailure(err)
  }

  const unresolvable = await findUnresolvableAccounts(
    supabase,
    companyId,
    paymentLines.map((l) => l.account_number),
  )
  if (unresolvable.length > 0) {
    return { ok: false, code: 'ACCOUNTS_NOT_IN_CHART', error: new AccountsNotInChartError(unresolvable) }
  }

  // An API key's unattended ceiling, on the payment verifikat, before the sale
  // posts anything: the engine refuses it at commit too, but by then the sale
  // would stand without the payment.
  if (actorUnattendedCeiling() !== null) {
    const overCeiling = unattendedCeilingRefusal(debitTotal(paymentLines))
    if (overCeiling) return { ok: false, code: overCeiling.code, error: overCeiling }
  }

  // From here on the match writes. The sale first: a correct booking of the
  // sent invoice whatever happens to the match after it.
  const sale = await bookSaleBeforeSettlement(ctx, salePlan)
  if (!sale.ok) return sale
  if (sale.bookedHere && sale.journalEntryId) postedIds.sale_journal_entry_id = sale.journalEntryId

  // Posting port (step 2f-2): what the door saw, read only while
  // POSTING_EVENTS is on. The caller named this bank line for this invoice;
  // the request scope turns the basis into agent_proposed_user_approved
  // inside an approval and client_asserted on an API key.
  const posting = (): InvoicePaymentPostingContext => ({
    linkBasis: linkBasisColumns('user_confirmed'),
    settledAmount: roundOre(newPaidAmount - (invoice.paid_amount ?? 0)),
  })

  let journalEntryId: string | null = null
  try {
    if (useCashEntry && !customLines) {
      const journalEntry = await createInvoiceCashEntry(
        supabase,
        companyId,
        userId,
        invoice,
        transaction.date,
        entityType,
        invoice.customer?.name ?? undefined,
        paymentAccount,
        transaction,
        overpaymentAccount,
        posting,
        { deferDeductionShare: accountingMethod === 'cash', feeAccount },
      )
      journalEntryId = journalEntry?.id ?? null
    } else {
      // Edited rows keep their routing's source_type so the payment sync
      // (which keys off invoice_paid / invoice_cash_payment) keeps working.
      const input: CreateJournalEntryInput = {
        fiscal_period_id: fiscalPeriodId,
        entry_date: transaction.date,
        description,
        source_type: customLines && useCashEntry ? 'invoice_cash_payment' : 'invoice_paid',
        source_id: invoice.id,
        bank_booking_context: [bankBookingContext(transaction, paymentAccount)],
        lines: paymentLines,
      }
      const journalEntry = await postingPort.postJournalEntry({
        supabase,
        companyId,
        userId,
        event: () =>
          invoicePaymentBusinessEvent(
            invoice,
            input,
            { paymentAccount: customLines ? null : paymentAccount, generated: !customLines, bankLine: true },
            posting(),
          ),
        input,
      })
      journalEntryId = journalEntry?.id ?? null
    }
  } catch (err) {
    return bookingFailure(err)
  }
  // Fail closed: the invoice is never marked paid without its verifikat.
  if (!journalEntryId) {
    return withPosted({ ok: false, code: 'INVOICE_PAID_BOOK_FAILED', details: { reason: 'no_journal_entry_created' } })
  }
  const paymentEntryId = journalEntryId

  // Claim the bank row right after its payment verifikat posts, as a
  // compare-and-set on what the gate read: a concurrent booking or match of
  // the row makes this a no-op, and the verifikat just posted is cancelled
  // instead of standing next to the other booking. The pointer the gate let
  // through is null, or a verifikat no longer posted. The match supersedes the
  // row's suggestion. The category stays the row's own: 'income_services' on
  // a goods sale was a guess, and the verifikat is the booking truth.
  const claim = supabase
    .from('transactions')
    .update({
      invoice_id: invoiceId,
      potential_invoice_id: null,
      journal_entry_id: paymentEntryId,
      is_business: true,
      // A stale link's method must not survive the new pointer. A literal so
      // the phantom-column scanner can verify the column set.
      reconciliation_method: null,
      ...linkBasisColumns('user_confirmed'),
    })
    .eq('id', transactionId)
    .eq('company_id', companyId)
    .is('invoice_id', null)
  const { data: claimedRows, error: claimError } = await (transaction.journal_entry_id
    ? claim.eq('journal_entry_id', transaction.journal_entry_id)
    : claim.is('journal_entry_id', null)
  ).select('id')

  if (claimError || !claimedRows || claimedRows.length === 0) {
    await cancelPaymentEntry(paymentEntryId, 'Automatiskt makulerad: dubblettbokning förhindrad av samtidighetsskydd')
    if (claimError) {
      log.error('failed to link transaction to invoice', claimError)
      return withPosted({ ok: false, code: 'MATCH_INVOICE_LINK_TX_FAILED' })
    }
    return withPosted({
      ok: false,
      code: 'MATCH_INVOICE_TX_ALREADY_BOOKED',
      details: { journal_entry_id: null, voucher: null, via: 'concurrent', undo: null },
    })
  }

  // Undo what this call wrote after the payment verifikat, newest first, and
  // cancel the verifikat: a match that stops here must leave neither a payment
  // verifikat with no payment nor an invoice settled by a cancelled one. Each
  // write is a compare-and-set on this call's own state, so nothing a
  // concurrent request wrote is touched. Never throws.
  const unwind = async (explanation: string, opts: { invoice: boolean }) => {
    if (opts.invoice) {
      const { error } = await supabase
        .from('invoices')
        .update({
          status: invoice.status,
          paid_at: invoice.paid_at ?? null,
          paid_amount: invoice.paid_amount,
          remaining_amount: invoice.remaining_amount,
        })
        .eq('id', invoiceId)
        .eq('company_id', companyId)
        .eq('status', newStatus)
        .eq('paid_amount', newPaidAmount)
      if (error) log.error('customer bank match: invoice update not undone', error, { journalEntryId: paymentEntryId })
    }
    const { error: releaseError } = await supabase
      .from('transactions')
      .update({
        invoice_id: null,
        potential_invoice_id: transaction.potential_invoice_id ?? null,
        journal_entry_id: transaction.journal_entry_id ?? null,
        is_business: transaction.is_business ?? null,
        reconciliation_method: transaction.reconciliation_method ?? null,
      })
      .eq('id', transactionId)
      .eq('company_id', companyId)
      .eq('journal_entry_id', paymentEntryId)
    if (releaseError) log.error('customer bank match: bank row not released', releaseError, { journalEntryId: paymentEntryId })
    await cancelPaymentEntry(paymentEntryId, explanation)
  }

  // Optimistic lock: the invoice must still be in a matchable state.
  const { data: updatedRows, error: updateInvError } = await supabase
    .from('invoices')
    .update({ status: newStatus, paid_at: paidAt, paid_amount: newPaidAmount, remaining_amount: newRemaining })
    .eq('id', invoiceId)
    .eq('company_id', companyId)
    .in('status', [...MATCHABLE_INVOICE_STATUSES])
    .select('id')

  if (updateInvError) {
    log.error('failed to update invoice status', updateInvError)
    await unwind('Automatiskt makulerad: matchningen kunde inte sparas', { invoice: false })
    return withPosted({ ok: false, code: 'INVOICE_PAID_BOOK_FAILED', error: updateInvError })
  }
  if (!updatedRows || updatedRows.length === 0) {
    // Settled by a concurrent request: the verifikat belongs to no payment.
    await unwind('Automatiskt makulerad: dubblettbokning förhindrad av samtidighetsskydd', { invoice: false })
    return withPosted({ ok: false, code: 'MATCH_INVOICE_ALREADY_PAID' })
  }

  // Provenance for a manually supplied rate: Riksbanken's is reproducible, a
  // rate typed off a bank statement overrides ML 8 kap 21-23 § and must leave
  // a trail on the payment row (BFL 5 kap 6-7 §).
  const manualRateNote =
    fx.required && fx.source === 'manual'
      ? `Manuell valutakurs ${fx.rate} ${invoice.currency}/SEK (betalningsdatum ${transaction.date})`
      : null

  // The AR sub-ledger row, through the single writer: the amount APPLIED to
  // the invoice, never the cash received, so a whole-krona overshoot absorbed
  // on 3740 stays in the voucher and out of the receivable (#2250). The rate
  // is the one actually used for this payment (ML 8 kap 21-23 §).
  const recorded = await recordInvoicePaymentRow(supabase, {
    userId,
    companyId,
    invoice,
    paymentDate: transaction.date,
    newPaidAmount,
    journalEntryId: paymentEntryId,
    transactionId,
    exchangeRate: fx.required ? fx.rate : invoice.exchange_rate,
    notes: manualRateNote,
    source: 'bank',
    // The caller named this bank line for this invoice.
    linkBasis: { basis: 'user_confirmed' },
  })
  if (!recorded.ok) {
    await unwind('Automatiskt makulerad: betalningen kunde inte registreras på fakturan', { invoice: true })
    if (recorded.code === '23505') return withPosted({ ok: false, code: 'MATCH_INVOICE_DUPLICATE_PAYMENT' })
    log.error('failed to record invoice payment', undefined, { error: recorded.error })
    return withPosted({ ok: false, code: 'MATCH_INVOICE_RECORD_PAYMENT_FAILED' })
  }

  // The invoice is settled, so every OTHER row still suggesting it is dead
  // (issue #1259). This row's own suggestion went with the claim.
  if (isFullyPaid) {
    await clearSettledInvoiceSuggestions(supabase, companyId, 'invoice', invoiceId, {
      exceptTransactionId: transactionId,
    })
  }

  // Underlag for the payment verifikat: the invoice's own PDF, linked at
  // issue or booked first above. document_attachments.journal_entry_id is
  // one-to-one, so a parallel row points at the same storage path: the same
  // WORM file, a second verifikat. Non-blocking: the match stands.
  const invoiceJournalEntryId = invoice.journal_entry_id ?? sale.journalEntryId
  if (invoiceJournalEntryId) {
    try {
      const { data: invoiceDoc } = await supabase
        .from('document_attachments')
        .select('storage_path, file_name, file_size_bytes, mime_type, sha256_hash')
        .eq('journal_entry_id', invoiceJournalEntryId)
        .eq('company_id', companyId)
        .eq('is_current_version', true)
        .limit(1)
        .maybeSingle()
      if (invoiceDoc) {
        const { error: attachError } = await supabase.from('document_attachments').insert({
          user_id: userId,
          company_id: companyId,
          uploaded_by: userId,
          upload_source: 'system',
          storage_path: invoiceDoc.storage_path,
          file_name: invoiceDoc.file_name,
          file_size_bytes: invoiceDoc.file_size_bytes,
          mime_type: invoiceDoc.mime_type,
          sha256_hash: invoiceDoc.sha256_hash,
          journal_entry_id: paymentEntryId,
          // The invoice's own PDF follows it onto its payment verifikat.
          ...linkBasisColumns('system_derived', { rule_id: 'invoice_document_on_payment' }),
        })
        if (attachError) {
          log.warn('failed to attach invoice PDF to payment journal entry', {
            attachError: attachError.message,
            paymentJournalEntryId: paymentEntryId,
            invoiceJournalEntryId,
          })
        }
      }
    } catch (err) {
      log.warn('failed to attach invoice PDF to payment journal entry', err as Error)
    }
  }

  // The bank row's own underlag, as on every booking of a row (BFL 5 kap 6-7 §).
  // After the last step that can unwind: anchoring cannot be undone, so a
  // verifikat this match cancels must never get it. Never throws.
  await propagateUnderlagForBookedTransaction(supabase, companyId, transactionId, paymentEntryId)

  // The override was acted on: a durable behandlingshistorik record
  // (BFNAR 2013:2 p. 9.16), same event the categorize guard writes.
  if (duplicate.status === 'overridden') {
    await recordDuplicateCandidateOverride(
      companyId,
      transactionId,
      duplicate.candidate,
      { actor: { type: 'user', id: userId }, via: args.overrideVia },
      (err) => log.warn('customer bank match: failed to record override behandlingshistorik', err as Error),
    )
  }

  await logMatchEvent(supabase, userId, transactionId, 'matched', {
    invoiceId,
    matchConfidence: 1.0,
    matchMethod: 'manual_confirm',
    // rate_source and exchange_rate keep a user-supplied rate on a money path
    // distinguishable from a Riksbanken lookup in the trail. Same-currency
    // matches carry rate_source: null.
    newState: {
      status: newStatus,
      paid_amount: newPaidAmount,
      remaining_amount: newRemaining,
      rate_source: fx.required ? fx.source : null,
      exchange_rate: fx.required ? fx.rate : null,
    },
  })

  const settledInvoice = { ...invoice, status: newStatus, paid_at: paidAt, paid_amount: newPaidAmount, remaining_amount: newRemaining } as Invoice
  try {
    await eventBus.emit({
      type: 'invoice.match_confirmed',
      payload: {
        invoice: settledInvoice,
        transaction: {
          ...transaction,
          invoice_id: invoiceId,
          potential_invoice_id: null,
          journal_entry_id: paymentEntryId,
          is_business: true,
        } as Transaction,
        userId,
        companyId,
      },
    })
  } catch (err) {
    log.warn('invoice.match_confirmed event emission failed', err as Error)
  }
  // A match that settles the invoice in full is its invoice.paid transition; a
  // partial match is not. The status compare-and-set admits one winner, so
  // this fires once. paymentAmount is the amount applied, as on the payment row.
  await emitInvoicePaidIfSettled({
    newStatus,
    invoice: settledInvoice,
    paymentAmount: roundOre(newPaidAmount - (invoice.paid_amount ?? 0)),
    paymentDate: transaction.date,
    userId,
    companyId,
  })
  // A befarad kundförlust reserve the payment made unnecessary comes back
  // (Dr 1519 / Cr 6352), as on every payment path. Never throws.
  await releaseDoubtfulReserveAfterChange(supabase, companyId, userId, {
    invoiceId: invoice.id,
    entryDate: transaction.date,
    trigger: 'payment',
  })

  return {
    ok: true,
    journalEntryId: paymentEntryId,
    invoiceStatus: newStatus,
    paidAt,
    paidAmount: newPaidAmount,
    remainingAmount: newRemaining,
    category: transaction.category ?? null,
    saleJournalEntryId: sale.bookedHere ? sale.journalEntryId : null,
    saleWarnings: sale.warnings,
    overpayment: matchPlan.overpayment,
    fee: matchPlan.fee,
  }
}
