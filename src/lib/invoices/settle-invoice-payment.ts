import type { SupabaseClient } from '@supabase/supabase-js'
import { releaseDoubtfulReserveAfterChange } from '@/lib/customer-loss/doubtful'
import {
  checkPriorCashRecognition,
  createInvoiceCashEntry,
  createInvoiceCashPartialEntry,
  createInvoicePaymentJournalEntry,
} from '@/lib/bookkeeping/invoice-entries'
import { buildInvoiceCashPartialLines } from '@/lib/bookkeeping/invoice-lines'
import { findFiscalPeriod } from '@/lib/bookkeeping/engine'
import { invoicePaymentBusinessEvent, type InvoicePaymentPostingContext } from '@/lib/bookkeeping/invoice-business-events'
import { cashPartialBlockReason } from '@/lib/bookkeeping/booking-mode'
import { carriedSekOf } from '@/lib/bookkeeping/ledger-carried-sek'
import { ORE_TOLERANCE, equalOre, isZeroOre, roundOre } from '@/lib/money'
import { lineBalance } from '@/lib/bookkeeping/line-balance'
import { resolveInvoicePaymentSourceType } from '@/lib/bookkeeping/propose-payment-lines'
import { isBookkeepingError } from '@/lib/bookkeeping/errors'
import { cancelOrphanedPaymentEntry } from '@/lib/bookkeeping/cancel-orphaned-entry'
import { planInvoicePaymentForLines } from '@/lib/invoices/apply-invoice-payment'
import { clearSettledInvoiceSuggestions } from '@/lib/invoices/clear-settled-invoice-suggestions'
import { recordInvoiceDuplicateGuardBypass, type DuplicateGuardBypassActor } from '@/lib/invoices/duplicate-guard-history'
import { invoicePayableRefusal, type InvoicePayableRefusal } from '@/lib/invoices/invoice-payable'
import {
  recordInvoicePaymentRow,
  removeInvoicePaymentRow,
  type InvoicePaymentSource,
} from '@/lib/invoices/invoice-payment-row'
import { paidAtFromDate } from '@/lib/invoices/paid-at'
import { emitInvoicePaidIfSettled } from '@/lib/invoices/paid-events'
import { linkBasisColumnsFor, type LinkBasisInput } from '@/lib/links/stamp'
import { postingPort } from '@/lib/posting/port'
import type {
  CreateJournalEntryInput,
  CreateJournalEntryLineInput,
  Customer,
  EntityType,
  Invoice,
} from '@/types'
import { MATCHABLE_INVOICE_STATUSES } from '@/lib/bookkeeping/matchable-statuses'
import { cashPartialPaymentsEnabled } from '@/lib/env/cash-partial-payments-switch'
import {
  bookSaleBeforeSettlement,
  clearsReceivable,
  planSaleBeforeSettlement,
  type SaleFirstRefusal,
} from '@/lib/invoices/sale-first'
import { createLogger } from '@/lib/logger'
import type { OperationWarning } from '@/lib/operations/types'

const log = createLogger('settle-invoice-payment')

/**
 * The core "apply a payment to an invoice" operation, extracted from the
 * mark-paid route so the Stripe payment sync (and any future automated payment
 * channel) shares the exact same booking, status transition, orphan handling
 * and event emission as the manual flow:
 *
 *   1. planInvoicePayment: ledger math + overpayment guard
 *   2. the sale first, when the company books invoices in a separate step
 *      (faktureringsmetoden with defer_invoice_booking) and this one has no
 *      verifikat yet: the Bokför step books it on its invoice date, and a
 *      refusal there refuses the payment with nothing written
 *      (lib/invoices/sale-first.ts)
 *   3. journal entry: custom lines | cash entry (kontantmetoden, unbooked;
 *      pro rata per installment when the payment is partial and
 *      CASH_PARTIAL_PAYMENTS_ENABLED is set) | payment entry (clears 1510),
 *      fail-closed for real invoices
 *   4. invoice_payments row (the AR sub-ledger): the only source of the
 *      payment DATE, which the kontantmetod bokslut cut-off, the voucher ->
 *      invoice reference map and the "Betalningar" view all read (#2019)
 *   5. CAS-guarded invoice status update; a lost race or failed update cancels
 *      the just-posted payment voucher and removes the payment row so GL and
 *      sub-ledger never diverge (a sale booked in step 2 stands: it is the
 *      correct booking of a sent invoice either way)
 *   6. invoice.paid event when the invoice is now fully paid (best-effort)
 *
 * `settlementAccountNumber` routes the debit side: the bank account from
 * resolveInvoiceSettlementAccount, 1686 for PSP-balance settlements (Stripe)
 * where the money reaches the bank only with the later payout.
 *
 * Whether the document can be paid at all is invoicePayableRefusal's answer,
 * asked first here so no door can skip it. Caller-owned concerns stay in the
 * callers: fetching the invoice, request parsing, the duplicate-payment guard
 * (a UX advisory: the Stripe sync skips it because the payment event IS the
 * authoritative payment), and mapping the result to a transport-specific
 * response. A door that overrode that guard says so (duplicateGuardBypass),
 * and the override is recorded here, naming the voucher it produced.
 */

export interface SettleCustomLine {
  account_number: string
  debit_amount: number
  credit_amount: number
  line_description?: string
}

/**
 * Invoice shape at the settlement boundary. Callers typically join only the
 * customer's name (`customer:customers(name)`), so the relation is modelled
 * as exactly that: reading any other Customer field here would be undefined
 * at runtime. A fully joined Customer still satisfies this structurally.
 */
export type InvoiceWithCustomerName = Omit<Invoice, 'customer'> & {
  customer?: Pick<Customer, 'name'> | null
}

export interface SettleInvoicePaymentParams {
  invoice: InvoiceWithCustomerName
  /** Payment amount in the INVOICE currency (caller converts if needed). */
  paymentAmountInInvoiceCurrency: number
  /** Booking date (YYYY-MM-DD). */
  paymentDate: string
  accountingMethod: string
  entityType: EntityType
  /** FX difference in SEK (manual flow only). */
  exchangeRateDifference?: number
  /** Caller-supplied booking lines (manual dialog only); must balance. */
  customLines?: SettleCustomLine[]
  /** Debit-side account: resolveInvoiceSettlementAccount on a manual payment. Stripe settlements pass '1686'. */
  settlementAccountNumber: string
  /**
   * Where the payment came from (invoice_payments.source): 'manual' for
   * "Markera som betald", 'stripe' for the Stripe sync, 'collections' for a
   * payment the collections provider collected (never reported back to it).
   */
  paymentSource?: InvoicePaymentSource
  /** The payment's reference in the system it came from (invoice_payments.external_ref). */
  externalRef?: string | null
  /**
   * Who overrode the duplicate-payment guard on this full settlement: it goes
   * in the behandlingshistorik with the voucher (BFNAR 2013:2 p. 9.16).
   * Omitted when the guard ran, or never applied.
   */
  duplicateGuardBypass?: DuplicateGuardBypassActor
  /**
   * The kontantfaktura (crm#1281): the invoice is paid at the moment it is
   * issued, so the sale and the payment are one affärshändelse and one
   * verifikat (19xx debit, 30xx and 26xx credit), whatever the accounting
   * method. An invoice that has no verifikat of its own then settles exactly
   * as under kontantmetoden: the generated cash entry, full amount only.
   * Ignored once the invoice is booked: its payment clears 1510 as always.
   */
  recognizeSaleAtPayment?: boolean
}

export type SettleInvoicePaymentResult =
  | {
      ok: true
      newStatus: 'paid' | 'partially_paid'
      newPaidAmount: number
      newRemaining: number
      journalEntryId: string | null
      paidAt: string | null
      /** The sale verifikat this payment booked first (defer_invoice_booking), else null. */
      saleJournalEntryId: string | null
      /** The Bokför step's non-blocking warnings when it booked the sale here. */
      warnings: OperationWarning[]
    }
  | { ok: false; code: 'MATCH_AMOUNT_EXCEEDS_REMAINING'; details: Record<string, unknown> }
  | { ok: false; code: 'INVOICE_PAID_CASH_PARTIAL_UNSUPPORTED'; details: Record<string, unknown> }
  | { ok: false; code: 'INVOICE_PAID_LINES_UNBALANCED'; details: Record<string, unknown> }
  | { ok: false; code: 'INVOICE_PAID_NO_FISCAL_PERIOD'; details: Record<string, unknown> }
  | { ok: false; code: 'INVOICE_PAID_BOOK_FAILED'; details: Record<string, unknown> }
  | ({ ok: false } & InvoicePayableRefusal)
  | { ok: false; code: 'INVOICE_PAID_RACE' }
  | { ok: false; code: 'BOOKKEEPING_ERROR'; error: unknown }
  | { ok: false; code: 'UPDATE_FAILED'; error: unknown }
  /**
   * The sale this payment must book first was refused by the Bokför step (or
   * the payment date takes no verifikat): `refusal` carries that code, with
   * details.sale_first. Nothing was written.
   */
  | { ok: false; code: 'SALE_FIRST_REFUSED'; refusal: SaleFirstRefusal }

/**
 * Why a settled payment is linked to its invoice. "Markera som betald"
 * creates the payment voucher from a person's statement that the invoice is
 * paid; a payment sync (Stripe) or the collections provider's settlement
 * creates it without anyone choosing the pair, and names its reference.
 */
function settlementLinkBasis(paymentSource: InvoicePaymentSource | undefined, externalRef: string | null | undefined): LinkBasisInput {
  const reference = externalRef ? { reference: externalRef.slice(0, 200) } : {}
  if (paymentSource === 'stripe' || paymentSource === 'collections') {
    return { basis: 'system_derived', evidence: { source_system: paymentSource, ...reference } }
  }
  return { basis: 'user_created', ...(externalRef ? { evidence: reference } : {}) }
}

export async function settleInvoicePayment(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  params: SettleInvoicePaymentParams,
): Promise<SettleInvoicePaymentResult> {
  const {
    invoice,
    paymentAmountInInvoiceCurrency,
    paymentDate,
    accountingMethod,
    entityType,
    exchangeRateDifference,
    customLines,
    settlementAccountNumber,
    paymentSource,
    externalRef,
    recognizeSaleAtPayment,
    duplicateGuardBypass,
  } = params

  const notPayable = await invoicePayableRefusal(supabase, companyId, invoice, paymentDate)
  if (notPayable) return { ok: false, ...notPayable }

  // Drive the JE shape from the invoice's actual booking state, not from
  // the current accounting_method setting. If the invoice was booked at
  // send (Dr 1510 / Cr 30xx + VAT), the payment MUST clear 1510:
  // otherwise the receivable orphans and 30xx + VAT double-count. Only
  // when there is no prior JE (pure kontantmetoden) do we recognise
  // revenue + VAT here.
  const invoiceAlreadyBooked = !!(invoice as { journal_entry_id?: string | null })
    .journal_entry_id
  const useCashEntry =
    !invoiceAlreadyBooked && (accountingMethod === 'cash' || recognizeSaleAtPayment === true)
  // The method the generated entry follows: a kontantfaktura books the sale
  // at payment like kontantmetoden, so the full-amount guard and the voucher
  // series follow that shape too.
  const bookingMethod = useCashEntry ? 'cash' : accountingMethod

  // Ledger math + overpayment guard. Runs BEFORE any journal entry is
  // created so a doomed overpayment never burns a voucher number.
  // Custom-line SEK settlements absorb a sub-krona öresavrundning residual
  // (customer paid the rounded "Att betala" from the PDF, up to 1 kr off the
  // stored öre total) ONLY when the lines actually carry the residual on
  // 3740, mirroring the bank-transaction match flow; lines that don't (e.g.
  // a deliberate sub-krona partial) get the strict plan instead. The
  // generated-entry paths (Stripe sync, no-body mark-paid) always pay the
  // exact remaining, so absorption is a no-op there.
  const payment = planInvoicePaymentForLines(
    invoice,
    paymentAmountInInvoiceCurrency,
    customLines,
    invoice.currency,
  )
  if (!payment.ok) {
    return {
      ok: false,
      code: 'MATCH_AMOUNT_EXCEEDS_REMAINING',
      details: payment.details as Record<string, unknown>,
    }
  }
  const { newPaidAmount, newRemaining, newStatus } = payment.plan
  const paidAt = newStatus === 'paid' ? paidAtFromDate(paymentDate) : null

  const isRealInvoice = !invoice.document_type || invoice.document_type === 'invoice'

  // The whole-payment cash entry (createInvoiceCashEntry) books the FULL
  // invoice and takes no payment amount, so it is only right for a payment
  // that settles a fully unpaid invoice. Bokslutsmetoden reports moms at
  // payment, per installment: a partial, or the completion of an earlier
  // partial, books one pro-rata installment instead
  // (buildInvoiceCashPartialLines), whose installments together book exactly
  // what the whole-payment entry would. Refused, as before, for what the
  // builder cannot split:
  //   - custom lines: the dialog pre-fills the whole-invoice shape, so they
  //     would book the old error under a user-shaped label;
  //   - foreign-currency and ROT/RUT invoices, and lines that do not add up
  //     to the total (the builder's own refusals);
  //   - a plan the builder disagrees with on what is still owed;
  //   - earlier installments the ledger does not show as pro-rata ones
  //     (checkPriorCashRecognition), where the next share would double-count.
  // The pro-rata rule waits for the accountant: while
  // CASH_PARTIAL_PAYMENTS_ENABLED is unset every such payment is refused as
  // it always was, with the same details, on every door that reaches here.
  const cashBlock = cashPartialBlockReason({
    invoiceAlreadyBooked,
    accountingMethod: bookingMethod,
    priorPaidAmount: invoice.paid_amount,
    paysRemainingInFull: newStatus === 'paid',
  })
  const proRataEnabled = cashPartialPaymentsEnabled()
  let cashInstallment: { description: string; lines: CreateJournalEntryLineInput[] } | null = null
  // The pro-rata rule is kontantmetoden's: a kontantfaktura under
  // faktureringsmetoden (recognizeSaleAtPayment) takes the cash shape only
  // because it is paid at issue, so it stays full amount only.
  if (isRealInvoice && cashBlock && (!proRataEnabled || accountingMethod !== 'cash')) {
    return {
      ok: false,
      code: 'INVOICE_PAID_CASH_PARTIAL_UNSUPPORTED',
      details: {
        reason: cashBlock,
        payment_amount: paymentAmountInInvoiceCurrency,
        paid_amount: invoice.paid_amount ?? 0,
        invoice_total: invoice.total,
      },
    }
  }
  if (isRealInvoice && cashBlock) {
    const refuse = (
      unsupported: string,
      extra?: Record<string, unknown>,
    ): SettleInvoicePaymentResult => ({
      ok: false,
      code: 'INVOICE_PAID_CASH_PARTIAL_UNSUPPORTED',
      details: {
        reason: cashBlock,
        unsupported,
        payment_amount: paymentAmountInInvoiceCurrency,
        paid_amount: invoice.paid_amount ?? 0,
        invoice_total: invoice.total,
        ...extra,
      },
    })
    if (customLines) return refuse('custom_lines')

    const priorPaid = invoice.paid_amount ?? 0
    const installment = buildInvoiceCashPartialLines(
      invoice,
      entityType,
      { priorPaid, amount: paymentAmountInInvoiceCurrency },
      invoice.customer?.name ?? undefined,
      settlementAccountNumber,
    )
    if (!installment.ok) return refuse(installment.reason)
    // The plan (remaining_amount) and the builder (total minus paid_amount)
    // must agree on what this payment leaves: the invoice reaches paid only
    // when its installments have recognised all of it.
    if (installment.settles !== (newStatus === 'paid') || !equalOre(installment.paidAfter, newPaidAmount)) {
      return refuse('remaining_mismatch', { paid_after: installment.paidAfter, new_paid_amount: newPaidAmount })
    }
    if (!isZeroOre(priorPaid)) {
      const prior = await checkPriorCashRecognition(
        supabase,
        companyId,
        invoice.id,
        priorPaid,
        installment.recognisedBefore,
      )
      if (!prior.ok) return refuse(prior.reason, prior.details)
    }
    cashInstallment = { description: installment.description, lines: installment.lines }
  }

  let journalEntryId: string | null = null
  let saleJournalEntryId: string | null = null
  let saleWarnings: OperationWarning[] = []
  // A failure after the sale was booked names it: that verifikat stands.
  const withSale = (details: Record<string, unknown>): Record<string, unknown> =>
    saleJournalEntryId ? { ...details, sale_journal_entry_id: saleJournalEntryId } : details

  // Posting port (step 2f-2): what this door saw, read only while
  // POSTING_EVENTS is on. The link basis is the payment row's (a person's
  // statement, or a payment sync's reference), and the debt settled is the
  // amount the row records as applied to the invoice.
  const posting = (): InvoicePaymentPostingContext => ({
    linkBasis: linkBasisColumnsFor(settlementLinkBasis(paymentSource, externalRef)),
    settledAmount: roundOre(newPaidAmount - (invoice.paid_amount ?? 0)),
  })

  if (isRealInvoice) {
    // Edited rows must balance and the payment date needs an open period:
    // both refused before the sale below is booked.
    let customLinesPeriodId: string | null = null
    if (customLines) {
      const { balanced, totalDebit, totalCredit } = lineBalance(customLines)
      if (!balanced) {
        return {
          ok: false,
          code: 'INVOICE_PAID_LINES_UNBALANCED',
          details: { totalDebit, totalCredit },
        }
      }

      customLinesPeriodId = await findFiscalPeriod(supabase, companyId, paymentDate)
      if (!customLinesPeriodId) {
        return {
          ok: false,
          code: 'INVOICE_PAID_NO_FISCAL_PERIOD',
          details: { paymentDate },
        }
      }
    }

    // Faktureringsmetoden with defer_invoice_booking: an invoice sent without
    // its verifikat is booked first, by the Bokför step on its invoice date,
    // then paid against the 1510 it debits (lib/invoices/sale-first.ts). The
    // plan is the Bokför step's dry run plus the payment date's lock; a
    // refusal there refuses the payment before anything is written: never a
    // 1510 clearing without the sale that debits it. Edited rows that book
    // the revenue themselves carry the sale already (clearsReceivable), and
    // so does the generated cash entry: a kontantfaktura paid at issue
    // (recognizeSaleAtPayment) books its sale in its one verifikat, in
    // either accounting method, so booking the sale first would double the
    // revenue and the utgående moms.
    const paymentBooksSale = customLines ? !clearsReceivable(customLines) : useCashEntry
    if (!paymentBooksSale) {
      const opCtx = { supabase, companyId, userId, log: log.child({ invoiceId: invoice.id }) }
      const salePlan = await planSaleBeforeSettlement(opCtx, invoice, { settlementDate: paymentDate })
      if (!salePlan.ok) return { ok: false, code: 'SALE_FIRST_REFUSED', refusal: salePlan }
      const sale = await bookSaleBeforeSettlement(opCtx, salePlan)
      if (!sale.ok) return { ok: false, code: 'SALE_FIRST_REFUSED', refusal: sale }
      if (sale.bookedHere) {
        saleJournalEntryId = sale.journalEntryId
        saleWarnings = sale.warnings
      }
    }

    try {
      // customLinesPeriodId is set whenever customLines is (checked above).
      if (customLines && customLinesPeriodId) {
        const fiscalPeriodId = customLinesPeriodId
        const sourceType = resolveInvoicePaymentSourceType({
          invoiceAlreadyBooked,
          // Settings store a raw string; anything but 'cash' books as accrual,
          // matching the useCashEntry check above.
          accountingMethod: bookingMethod === 'cash' ? 'cash' : 'accrual',
        })
        const input: CreateJournalEntryInput = {
          fiscal_period_id: fiscalPeriodId,
          entry_date: paymentDate,
          description: invoice.customer?.name
            ? `Inbetalning kundfaktura ${invoice.invoice_number}, ${invoice.customer.name}`
            : `Inbetalning kundfaktura ${invoice.invoice_number}`,
          source_type: sourceType,
          source_id: invoice.id,
          lines: customLines,
        }
        // The person's own rows: no rule made them, and no payment account
        // is named, so the event carries no rule version and no kronor.
        const journalEntry = await postingPort.postJournalEntry({
          supabase,
          companyId,
          userId,
          event: () =>
            invoicePaymentBusinessEvent(invoice, input, { paymentAccount: null, generated: false, bankLine: false }, posting()),
          input,
        })
        journalEntryId = journalEntry?.id ?? null
      } else if (cashInstallment) {
        const journalEntry = await createInvoiceCashPartialEntry(
          supabase,
          companyId,
          userId,
          invoice.id,
          cashInstallment,
          paymentDate,
          () => ({ invoice: invoice as Invoice, context: posting() }),
        )
        journalEntryId = journalEntry?.id ?? null
      } else if (useCashEntry) {
        // The entry helpers never read invoice.customer (the display name is
        // passed explicitly), so the partial customer relation is safe here.
        const journalEntry = await createInvoiceCashEntry(
          supabase,
          companyId,
          userId,
          invoice as Invoice,
          paymentDate,
          entityType,
          invoice.customer?.name ?? undefined,
          settlementAccountNumber,
          undefined,
          undefined,
          posting,
          // Bokslutsmetoden's two steps for a ROT/RUT invoice; a kontantfaktura
          // under faktureringsmetoden reports the whole moms now.
          { deferDeductionShare: accountingMethod === 'cash' },
        )
        journalEntryId = journalEntry?.id ?? null
      } else {
        const journalEntry = await createInvoicePaymentJournalEntry(
          supabase,
          companyId,
          userId,
          // A sale booked first above is on the ledger by now.
          { ...(invoice as Invoice), carried_sek: await carriedSekOf(supabase, companyId, 'customer', invoice) },
          paymentDate,
          exchangeRateDifference,
          invoice.customer?.name ?? undefined,
          undefined,
          settlementAccountNumber,
          undefined,
          posting,
        )
        journalEntryId = journalEntry?.id ?? null
      }
    } catch (err) {
      if (isBookkeepingError(err)) {
        return { ok: false, code: 'BOOKKEEPING_ERROR', error: err }
      }
      return {
        ok: false,
        code: 'INVOICE_PAID_BOOK_FAILED',
        details: withSale({ reason: err instanceof Error ? err.message : 'unknown' }),
      }
    }

    // Fail closed: a real invoice must produce a payment voucher. If a helper
    // returned null without throwing (e.g. a closed/locked fiscal period),
    // refuse to mark the invoice paid: flipping status with no journal entry
    // orphans the receivable and diverges the GL from the sub-ledger.
    if (!journalEntryId) {
      return {
        ok: false,
        code: 'INVOICE_PAID_BOOK_FAILED',
        details: withSale({ reason: 'no_journal_entry_created' }),
      }
    }
  }

  // Sub-ledger row (see lib/invoices/invoice-payment-row.ts for why and for
  // the shape). Written BEFORE the CAS update so the failure branches below
  // can undo it together with the voucher; a real invoice never reaches paid
  // through this service without it.
  let paymentRowId: string | null = null
  if (isRealInvoice) {
    const recorded = await recordInvoicePaymentRow(supabase, {
      userId,
      companyId,
      invoice,
      paymentDate,
      newPaidAmount,
      journalEntryId,
      source: paymentSource ?? null,
      externalRef: externalRef ?? null,
      linkBasis: settlementLinkBasis(paymentSource, externalRef),
    })
    if (!recorded.ok) {
      if (journalEntryId) {
        await cancelOrphanedPaymentEntry(
          supabase,
          companyId,
          userId,
          journalEntryId,
          'Automatiskt makulerad: betalningsraden kunde inte sparas efter bokförd betalning',
        )
      }
      return {
        ok: false,
        code: 'INVOICE_PAID_BOOK_FAILED',
        details: withSale({ reason: 'payment_row_insert_failed', error: recorded.error }),
      }
    }
    paymentRowId = recorded.id
  }

  // CAS guard: only update if status is still in a payable state.
  let casUpdate = supabase
    .from('invoices')
    .update({
      status: newStatus,
      paid_amount: newPaidAmount,
      remaining_amount: newRemaining,
      ...(paidAt ? { paid_at: paidAt } : {}),
    })
    .eq('id', invoice.id)
    .eq('company_id', companyId)
    .in('status', [...MATCHABLE_INVOICE_STATUSES])
  if (isRealInvoice && useCashEntry && proRataEnabled) {
    // Every kontantmetoden entry here is computed from the paid_amount read
    // above: an installment takes its share from it, and the whole-payment
    // entry (or custom lines) assumes nothing was paid. When another payment
    // moved paid_amount in between, the entry no longer fits the invoice: two
    // installments would overlap, or a whole payment would book again the
    // revenue and moms of an installment that landed first. Lose the race
    // instead. The band is the half öre the read-side checks allow, so a
    // stored value that is not exactly two decimals never blocks a payment.
    // Only with the pro-rata rule on: without it no installment can land on
    // a never-booked invoice, and the update stays what it always was.
    const priorPaid = roundOre(invoice.paid_amount ?? 0)
    const above = priorPaid - ORE_TOLERANCE
    const below = priorPaid + ORE_TOLERANCE
    // Nothing paid yet: the band around zero, ±ORE_TOLERANCE (0.005), written
    // as a literal filter so the schema guard checks its columns.
    casUpdate =
      priorPaid === 0
        ? casUpdate.or('paid_amount.is.null,and(paid_amount.gt.-0.005,paid_amount.lt.0.005)')
        : casUpdate.gt('paid_amount', above).lt('paid_amount', below)
  }
  const { data: updateResult, error: updateError } = await casUpdate.select('id')

  if (updateError) {
    // The payment voucher already posted but the invoice row did not flip to
    // paid; cancel the orphan so the GL doesn't diverge from the sub-ledger.
    // Voucher first, then the row: a row the collections provider collected
    // may only be removed once its voucher is cancelled
    // (block_delete_collected_payment, 20261021120600).
    if (journalEntryId) {
      await cancelOrphanedPaymentEntry(
        supabase,
        companyId,
        userId,
        journalEntryId,
        'Automatiskt makulerad: fakturauppdatering misslyckades efter bokförd betalning',
      )
    }
    await removeInvoicePaymentRow(supabase, companyId, paymentRowId)
    return { ok: false, code: 'UPDATE_FAILED', error: updateError }
  }

  if (!updateResult || updateResult.length === 0) {
    // Status changed between read and write (concurrent settle): cancel the
    // orphaned payment voucher; the trigger documents the voucher gap.
    // Voucher first, then the row (same order as above).
    if (journalEntryId) {
      await cancelOrphanedPaymentEntry(
        supabase,
        companyId,
        userId,
        journalEntryId,
        'Automatiskt makulerad: dubblettbokning förhindrad av samtidighetsskydd',
      )
    }
    await removeInvoicePaymentRow(supabase, companyId, paymentRowId)
    return { ok: false, code: 'INVOICE_PAID_RACE' }
  }

  // Warned about a possible double payment and booked anyway: the books record
  // it. After the voucher exists, and never throws: the payment stands.
  if (duplicateGuardBypass && journalEntryId) {
    await recordInvoiceDuplicateGuardBypass(supabase, {
      companyId,
      invoice: {
        id: invoice.id,
        invoice_number: invoice.invoice_number,
        customer_name: invoice.customer?.name,
        currency: invoice.currency ?? null,
        total: invoice.total ?? null,
        total_sek: invoice.total_sek ?? null,
        exchange_rate: invoice.exchange_rate ?? null,
      },
      paymentAmount: paymentAmountInInvoiceCurrency,
      paymentDate,
      paymentAccount: customLines ? null : (settlementAccountNumber ?? null),
      journalEntryId,
      actor: duplicateGuardBypass,
    })
  }

  // Fully settled: retire every transaction's suggestion pointer at this
  // invoice (issue #1259). No exceptTransactionId: this flow is not driven by
  // a bank transaction, so any pointer at it is now dead.
  if (newStatus === 'paid') {
    await clearSettledInvoiceSuggestions(supabase, companyId, 'invoice', invoice.id)
  }

  // Notify subscribers: invoice.paid fans out to registered webhooks and the
  // Stripe extension's link-deactivation handler, once, when this payment
  // settles the invoice in full (never on a partial). Best-effort: the
  // payment is already committed, so an emit failure never fails it.
  await emitInvoicePaidIfSettled({
    newStatus,
    invoice: {
      ...invoice,
      ...(saleJournalEntryId ? { journal_entry_id: saleJournalEntryId } : {}),
      status: newStatus,
      paid_amount: newPaidAmount,
      remaining_amount: newRemaining,
      paid_at: paidAt ?? invoice.paid_at,
    } as Invoice,
    companyId,
    userId,
    paymentAmount: paymentAmountInInvoiceCurrency,
    paymentDate,
  })

  // A befarad kundförlust reserve the payment made unnecessary comes back in
  // the same run (Dr 1519 / Cr 6352). Never throws: the payment stands.
  await releaseDoubtfulReserveAfterChange(supabase, companyId, userId, {
    invoiceId: invoice.id,
    entryDate: paymentDate,
    trigger: 'payment',
  })

  return {
    ok: true,
    newStatus,
    newPaidAmount,
    newRemaining,
    journalEntryId,
    paidAt,
    saleJournalEntryId,
    warnings: saleWarnings,
  }
}
