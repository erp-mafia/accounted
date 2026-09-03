import type { SupabaseClient } from '@supabase/supabase-js'
import {
  createInvoicePaymentJournalEntry,
  createInvoiceCashEntry,
} from '@/lib/bookkeeping/invoice-entries'
import { createJournalEntry, findFiscalPeriod } from '@/lib/bookkeeping/engine'
import { cashPartialBlockReason } from '@/lib/bookkeeping/booking-mode'
import { resolveInvoicePaymentSourceType } from '@/lib/bookkeeping/propose-payment-lines'
import { isBookkeepingError } from '@/lib/bookkeeping/errors'
import { cancelOrphanedPaymentEntry } from '@/lib/bookkeeping/cancel-orphaned-entry'
import { planInvoicePaymentForLines } from '@/lib/invoices/apply-invoice-payment'
import { clearSettledInvoiceSuggestions } from '@/lib/invoices/clear-settled-invoice-suggestions'
import { paidAtFromDate } from '@/lib/invoices/paid-at'
import { eventBus } from '@/lib/events'
import type { CreateJournalEntryInput, Customer, EntityType, Invoice } from '@/types'

/**
 * The core "apply a payment to an invoice" operation, extracted from the
 * mark-paid route so the Stripe payment sync (and any future automated payment
 * channel) shares the exact same booking, status transition, orphan handling
 * and event emission as the manual flow:
 *
 *   1. planInvoicePayment: ledger math + overpayment guard
 *   2. journal entry: custom lines | cash entry (kontantmetoden, unbooked) |
 *      payment entry (clears 1510), fail-closed for real invoices
 *   3. invoice_payments row (the AR sub-ledger): the only source of the
 *      payment DATE, which the kontantmetod bokslut cut-off, the voucher ->
 *      invoice reference map and the "Betalningar" view all read (#2019)
 *   4. CAS-guarded invoice status update; a lost race or failed update cancels
 *      the just-posted voucher and removes the payment row so GL and
 *      sub-ledger never diverge
 *   5. invoice.paid event (best-effort)
 *
 * `settlementAccountNumber` routes the debit side: default 1930 (bank), 1686
 * for PSP-balance settlements (Stripe) where the money reaches the bank only
 * with the later payout.
 *
 * The function performs the write path only. Caller-owned concerns stay in
 * the callers: fetching the invoice, payable-status guards, request parsing,
 * the duplicate-payment guard (a UX advisory: the Stripe sync skips it
 * because the payment event IS the authoritative payment), and mapping the
 * result to a transport-specific response.
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
  /** Debit-side account; default '1930'. Stripe settlements pass '1686'. */
  settlementAccountNumber?: string
}

export type SettleInvoicePaymentResult =
  | {
      ok: true
      newStatus: 'paid' | 'partially_paid'
      newPaidAmount: number
      newRemaining: number
      journalEntryId: string | null
      paidAt: string | null
    }
  | { ok: false; code: 'MATCH_AMOUNT_EXCEEDS_REMAINING'; details: Record<string, unknown> }
  | { ok: false; code: 'INVOICE_PAID_CASH_PARTIAL_UNSUPPORTED'; details: Record<string, unknown> }
  | { ok: false; code: 'INVOICE_PAID_LINES_UNBALANCED'; details: Record<string, unknown> }
  | { ok: false; code: 'INVOICE_PAID_NO_FISCAL_PERIOD'; details: Record<string, unknown> }
  | { ok: false; code: 'INVOICE_PAID_BOOK_FAILED'; details: Record<string, unknown> }
  | { ok: false; code: 'INVOICE_PAID_NOT_PAYABLE'; details: Record<string, unknown> }
  | { ok: false; code: 'INVOICE_PAID_RACE' }
  | { ok: false; code: 'BOOKKEEPING_ERROR'; error: unknown }
  | { ok: false; code: 'UPDATE_FAILED'; error: unknown }

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
  } = params

  if (invoice.credited_invoice_id) {
    return {
      ok: false,
      code: 'INVOICE_PAID_NOT_PAYABLE',
      details: { reason: 'credit_note' },
    }
  }

  // Drive the JE shape from the invoice's actual booking state, not from
  // the current accounting_method setting. If the invoice was booked at
  // send (Dr 1510 / Cr 30xx + VAT), the payment MUST clear 1510:
  // otherwise the receivable orphans and 30xx + VAT double-count. Only
  // when there is no prior JE (pure kontantmetoden) do we recognise
  // revenue + VAT here.
  const invoiceAlreadyBooked = !!(invoice as { journal_entry_id?: string | null })
    .journal_entry_id
  const useCashEntry = !invoiceAlreadyBooked && accountingMethod === 'cash'

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

  // The generated cash entry (createInvoiceCashEntry) books the FULL invoice
  // and takes no payment amount, so a never-booked kontantmetoden invoice can
  // only be settled in full from a fully unpaid state. Partials used to book
  // the entire revenue + moms against a smaller bank movement (bokslutsmetoden
  // reports moms at payment, per installment), and completing a
  // prior partial would book the full total a second time. Custom lines are
  // NOT exempt: the dialog pre-fills the same full-invoice shape, so lines
  // would book the identical error under a user-shaped label.
  const cashBlock = cashPartialBlockReason({
    invoiceAlreadyBooked,
    accountingMethod,
    priorPaidAmount: invoice.paid_amount,
    paysRemainingInFull: newStatus === 'paid',
  })
  if (isRealInvoice && cashBlock) {
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

  let journalEntryId: string | null = null

  if (isRealInvoice) {
    try {
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

        const fiscalPeriodId = await findFiscalPeriod(supabase, companyId, paymentDate)
        if (!fiscalPeriodId) {
          return {
            ok: false,
            code: 'INVOICE_PAID_NO_FISCAL_PERIOD',
            details: { paymentDate },
          }
        }
        const sourceType = resolveInvoicePaymentSourceType({
          invoiceAlreadyBooked,
          // Settings store a raw string; anything but 'cash' books as accrual,
          // matching the useCashEntry check above.
          accountingMethod: accountingMethod === 'cash' ? 'cash' : 'accrual',
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
        const journalEntry = await createJournalEntry(supabase, companyId, userId, input)
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
        )
        journalEntryId = journalEntry?.id ?? null
      } else {
        const journalEntry = await createInvoicePaymentJournalEntry(
          supabase,
          companyId,
          userId,
          invoice as Invoice,
          paymentDate,
          exchangeRateDifference,
          invoice.customer?.name ?? undefined,
          undefined,
          settlementAccountNumber,
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
        details: { reason: err instanceof Error ? err.message : 'unknown' },
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
        details: { reason: 'no_journal_entry_created' },
      }
    }
  }

  // Sub-ledger row. Without it the payment has no DATE anywhere: the
  // kontantmetod cut-off (lib/core/bookkeeping/kontantmetod-cutoff.ts) reads
  // invoice_payments only and would book a paid invoice as a fordran with
  // vilande moms at bokslut, double-counting revenue and VAT (#2019). Same
  // shape as the bank-match path (app/api/transactions/[id]/match-invoice):
  // amount in INVOICE currency, transaction_id null because no bank line
  // drives this flow. The (transaction_id, invoice_id) unique index treats
  // nulls as distinct, so several manual partials on one invoice coexist.
  // Written BEFORE the CAS update so the failure branches below can undo it
  // together with the voucher; a real invoice never reaches paid without it.
  let paymentRowId: string | null = null
  if (isRealInvoice) {
    const { data: paymentRow, error: paymentInsertError } = await supabase
      .from('invoice_payments')
      .insert({
        user_id: userId,
        company_id: companyId,
        invoice_id: invoice.id,
        payment_date: paymentDate,
        amount: paymentAmountInInvoiceCurrency,
        currency: invoice.currency,
        exchange_rate: invoice.exchange_rate ?? null,
        journal_entry_id: journalEntryId,
        transaction_id: null,
        notes: null,
      })
      .select('id')
      .single()

    if (paymentInsertError || !paymentRow) {
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
        details: {
          reason: 'payment_row_insert_failed',
          error: paymentInsertError?.message ?? 'no_row_returned',
        },
      }
    }
    paymentRowId = (paymentRow as { id: string }).id
  }

  // CAS guard: only update if status is still in a payable state.
  const { data: updateResult, error: updateError } = await supabase
    .from('invoices')
    .update({
      status: newStatus,
      paid_amount: newPaidAmount,
      remaining_amount: newRemaining,
      ...(paidAt ? { paid_at: paidAt } : {}),
    })
    .eq('id', invoice.id)
    .eq('company_id', companyId)
    .in('status', ['sent', 'overdue', 'partially_paid'])
    .select('id')

  if (updateError) {
    // The payment voucher already posted but the invoice row did not flip to
    // paid; cancel the orphan so the GL doesn't diverge from the sub-ledger.
    await removePaymentRow(supabase, companyId, paymentRowId)
    if (journalEntryId) {
      await cancelOrphanedPaymentEntry(
        supabase,
        companyId,
        userId,
        journalEntryId,
        'Automatiskt makulerad: fakturauppdatering misslyckades efter bokförd betalning',
      )
    }
    return { ok: false, code: 'UPDATE_FAILED', error: updateError }
  }

  if (!updateResult || updateResult.length === 0) {
    // Status changed between read and write (concurrent settle): cancel the
    // orphaned payment voucher; the trigger documents the voucher gap.
    await removePaymentRow(supabase, companyId, paymentRowId)
    if (journalEntryId) {
      await cancelOrphanedPaymentEntry(
        supabase,
        companyId,
        userId,
        journalEntryId,
        'Automatiskt makulerad: dubblettbokning förhindrad av samtidighetsskydd',
      )
    }
    return { ok: false, code: 'INVOICE_PAID_RACE' }
  }

  // Fully settled: retire every transaction's suggestion pointer at this
  // invoice (issue #1259). No exceptTransactionId: this flow is not driven by
  // a bank transaction, so any pointer at it is now dead.
  if (newStatus === 'paid') {
    await clearSettledInvoiceSuggestions(supabase, companyId, 'invoice', invoice.id)
  }

  // Notify subscribers: invoice.paid fans out to registered webhooks and the
  // Stripe extension's link-deactivation handler. Best-effort: the payment is
  // already committed, so an emit failure must not fail the operation.
  try {
    await eventBus.emit({
      type: 'invoice.paid',
      payload: {
        invoice: {
          ...invoice,
          status: newStatus,
          paid_amount: newPaidAmount,
          remaining_amount: newRemaining,
          paid_at: paidAt ?? invoice.paid_at,
        } as Invoice,
        companyId,
        userId,
        paymentAmount: paymentAmountInInvoiceCurrency,
        paymentDate,
      },
    })
  } catch {
    // Swallowed by design; the DB state is the source of truth.
  }

  return {
    ok: true,
    newStatus,
    newPaidAmount,
    newRemaining,
    journalEntryId,
    paidAt,
  }
}

/**
 * Undo the sub-ledger row on a failed settlement. Best-effort like the
 * voucher storno next to it: the caller is already on a decided error path
 * (race or update failure), and that response must not be replaced by a
 * delete error. A stranded row is visible in the Betalningar view and
 * repairable; a swallowed CAS result is not.
 */
async function removePaymentRow(
  supabase: SupabaseClient,
  companyId: string,
  paymentRowId: string | null,
): Promise<void> {
  if (!paymentRowId) return
  try {
    await supabase
      .from('invoice_payments')
      .delete()
      .eq('id', paymentRowId)
      .eq('company_id', companyId)
  } catch {
    // Swallowed by design: the voucher storno and the error response are the
    // outcome that matters; a stranded row is repairable and visible.
  }
}
